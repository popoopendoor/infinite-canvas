import { createHash } from "node:crypto";

import type { AuthUser } from "../auth/oauth.js";
import type { Database } from "../db.js";
import { HttpError } from "../errors.js";
import { hashToken, randomToken } from "../crypto.js";
import type { ProviderExecutor } from "../provider/executor.js";
import type { CatalogEntry, ModelRequest } from "./catalog.js";
import { requestHash as baseRequestHash } from "./catalog.js";
import { BridgeClient, WalletUnknownError } from "./bridge-client.js";
import {
  findTask,
  getTask,
  insertTask,
  updateTask,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdate,
} from "./task-record.js";

type CustomCapabilityGrant = {
  task: TaskRecord;
  token?: string;
  expiresAt?: number;
};

export class CustomCapabilityService {
  private readonly starts = new Map<
    string,
    { requestHash: string; operation: Promise<CustomCapabilityGrant> }
  >();

  constructor(
    private readonly db: Database,
    private readonly bridge: BridgeClient,
    private readonly provider: ProviderExecutor,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly capabilitySeconds = 600,
  ) {}

  async start(
    user: AuthUser,
    request: ModelRequest,
    entry: CatalogEntry,
    scriptHash: string,
  ): Promise<CustomCapabilityGrant> {
    if (!/^[a-f0-9]{64}$/.test(scriptHash))
      throw new HttpError(400, "bad_request", "Script hash is invalid");
    const requestHash = customRequestHash(request, entry, scriptHash);
    const operationKey = `${user.id}:${request.idempotencyKey}`;
    const pending = this.starts.get(operationKey);
    if (pending) {
      if (pending.requestHash !== requestHash)
        throw new HttpError(
          409,
          "conflict",
          "Idempotency key is already bound to a different request",
        );
      const result = await pending.operation;
      return this.grantForExisting(result.task, user.id, scriptHash);
    }
    const existing = this.findByKey(user.id, request.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new HttpError(
          409,
          "conflict",
          "Idempotency key is already bound to a different request",
        );
      return this.grantForExisting(existing, user.id, scriptHash);
    }

    const operation = this.startOwned(
      user,
      request,
      entry,
      requestHash,
      scriptHash,
    );
    this.starts.set(operationKey, { requestHash, operation });
    try {
      return await operation;
    } finally {
      if (this.starts.get(operationKey)?.operation === operation)
        this.starts.delete(operationKey);
    }
  }

  private async startOwned(
    user: AuthUser,
    request: ModelRequest,
    entry: CatalogEntry,
    requestHash: string,
    scriptHash: string,
  ): Promise<CustomCapabilityGrant> {
    const { task, owner } = this.insert(
      user,
      request,
      entry,
      requestHash,
      scriptHash,
    );
    if (!owner) return this.grantForExisting(task, user.id, scriptHash);
    let held = false;
    try {
      await this.provider.validate?.(entry, request);
      const hold = await this.bridge.hold({
        userId: user.id,
        taskId: task.id,
        amount: entry.price,
        requestHash,
      });
      held = true;
      this.update(task.id, {
        status: "held",
        providerStatus: "custom_script_held",
        holdLedgerId: String(hold.ledgerId),
      });
      this.update(task.id, {
        status: "running",
        providerStatus: "custom_script_running",
      });
      return this.createGrant(task.id, user.id, scriptHash);
    } catch (error) {
      if (error instanceof WalletUnknownError)
        return this.updateAfterFailure(
          task.id,
          "pending_reconciliation",
          "hold_unknown",
          "Wallet hold result requires reconciliation",
        );
      if (held) {
        try {
          const release = await this.bridge.release({
            userId: user.id,
            taskId: task.id,
            amount: entry.price,
            requestHash,
          });
          this.update(task.id, { releaseLedgerId: String(release.ledgerId) });
        } catch {
          return this.updateAfterFailure(
            task.id,
            "pending_reconciliation",
            "capability_setup_unknown",
            "Capability setup failed and wallet release requires reconciliation",
          );
        }
      }
      return this.updateAfterFailure(
        task.id,
        "failed",
        error instanceof HttpError ? error.code : "provider_failed",
        error instanceof HttpError ? error.message : "Provider request failed",
      );
    }
  }

  active(userId: string, token: string) {
    const row = this.capabilityRow(userId, token);
    if (!row)
      throw new HttpError(401, "unauthenticated", "Capability is invalid");
    if (row.expires_at <= this.now() || !isActive(row.status)) {
      if (isActive(row.status)) {
        this.revoke(token);
        if (!this.hasActiveCapability(row.task_id))
          this.markPending(row.task_id, "capability_expired");
      }
      throw new HttpError(409, "conflict", "Capability is expired or inactive");
    }
    return this.getTask(userId, row.task_id);
  }

  async complete(
    userId: string,
    token: string,
    result: unknown,
    errorMessage?: string,
  ): Promise<TaskRecord> {
    const row = this.capabilityCompletionRow(userId, token);
    if (!row)
      throw new HttpError(401, "unauthenticated", "Capability is invalid");
    const task = this.getTask(userId, row.task_id);
    if (task.status === "succeeded" || task.status === "failed") return task;
    if (!isActive(task.status)) return task;
    if (row.expires_at <= this.now()) {
      this.revoke(token);
      if (!this.hasActiveCapability(task.id))
        this.markPending(task.id, "capability_expired");
      throw new HttpError(409, "conflict", "Capability is expired");
    }

    if (errorMessage) {
      try {
        const release = await this.bridge.release({
          userId,
          taskId: task.id,
          amount: task.amount,
          requestHash: task.requestHash,
        });
        this.update(task.id, { releaseLedgerId: String(release.ledgerId) });
      } catch {
        this.markPending(task.id, "release_unknown");
        throw new HttpError(
          503,
          "service_unavailable",
          "Wallet release requires reconciliation",
        );
      }
      this.revoke(token);
      return this.update(task.id, {
        status: "failed",
        providerStatus: "custom_script_failed",
        errorCode: "provider_failed",
        errorMessage,
      });
    }

    let resultJson: string;
    try {
      resultJson = JSON.stringify(result);
    } catch {
      this.markPending(task.id, "result_not_serializable");
      throw new HttpError(
        400,
        "bad_request",
        "Model result is not serializable",
      );
    }
    try {
      const capture = await this.bridge.capture({
        userId,
        taskId: task.id,
        amount: task.amount,
        requestHash: task.requestHash,
      });
      this.update(task.id, { captureLedgerId: String(capture.ledgerId) });
    } catch {
      this.markPending(task.id, "capture_unknown", resultJson);
      throw new HttpError(
        503,
        "service_unavailable",
        "Wallet capture requires reconciliation",
      );
    }
    this.revoke(token);
    return this.update(task.id, {
      status: "succeeded",
      providerStatus: "custom_script_succeeded",
      resultJson,
    });
  }

  abandon(userId: string, token: string) {
    const row = this.capabilityRow(userId, token);
    if (!row) return null;
    this.revoke(token);
    const task = this.getTask(userId, row.task_id);
    if (isActive(task.status) && !this.hasActiveCapability(task.id))
      this.markPending(task.id, "client_abandoned");
    return this.getTask(userId, row.task_id);
  }

  expire() {
    const now = this.now();
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE model_capabilities SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at <= ?",
        )
        .run(now, now);
      const tasks = this.db
        .prepare(
          "SELECT t.id FROM model_tasks t WHERE t.status IN ('created', 'held', 'running') AND EXISTS (SELECT 1 FROM model_capabilities c WHERE c.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM model_capabilities c WHERE c.task_id = t.id AND c.revoked_at IS NULL AND c.expires_at > ?)",
        )
        .all(now) as Array<{ id: string }>;
      for (const task of tasks) this.markPending(task.id, "capability_expired");
      return tasks.length;
    })();
  }

  private createGrant(taskId: string, userId: string, scriptHash: string) {
    const token = randomToken();
    const expiresAt = this.now() + this.capabilitySeconds;
    try {
      this.db
        .prepare(
          "INSERT INTO model_capabilities (token_hash, task_id, user_id, script_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(hashToken(token), taskId, userId, scriptHash, expiresAt);
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "Could not create model capability",
      );
    }
    return {
      task: this.getTask(userId, taskId),
      token,
      expiresAt,
    } satisfies CustomCapabilityGrant;
  }

  private grantForExisting(
    task: TaskRecord,
    userId: string,
    scriptHash: string,
  ) {
    if (task.status !== "running") return { task };
    return this.createGrant(task.id, userId, scriptHash);
  }

  private insert(
    user: AuthUser,
    request: ModelRequest,
    entry: CatalogEntry,
    requestHash: string,
    scriptHash: string,
  ): { task: TaskRecord; owner: boolean } {
    return insertTask(
      this.db,
      user,
      request,
      entry,
      requestHash,
      {
        prompt: request.prompt || "",
        messages: request.messages || [],
        params: request.params,
        references: request.references,
        customScriptHash: scriptHash,
      },
      "custom_script_created",
      this.now(),
    );
  }

  private findByKey(userId: string, idempotencyKey: string) {
    return findTask(this.db, userId, idempotencyKey);
  }

  private getTask(userId: string, id: string) {
    return getTask(this.db, userId, id);
  }

  private capabilityRow(userId: string, token: string) {
    return this.db
      .prepare(
        "SELECT c.task_id, c.expires_at, t.status FROM model_capabilities c JOIN model_tasks t ON t.id = c.task_id WHERE c.user_id = ? AND c.token_hash = ? AND c.revoked_at IS NULL",
      )
      .get(userId, hashToken(token)) as CapabilityRow | undefined;
  }

  private capabilityCompletionRow(userId: string, token: string) {
    return this.db
      .prepare(
        "SELECT c.task_id, c.expires_at, t.status FROM model_capabilities c JOIN model_tasks t ON t.id = c.task_id WHERE c.user_id = ? AND c.token_hash = ?",
      )
      .get(userId, hashToken(token)) as CapabilityRow | undefined;
  }

  private hasActiveCapability(taskId: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM model_capabilities WHERE task_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
        )
        .get(taskId, this.now()),
    );
  }

  private updateAfterFailure(
    taskId: string,
    status: TaskStatus,
    errorCode: string,
    errorMessage: string,
  ): CustomCapabilityGrant {
    const task = this.update(taskId, {
      status,
      providerStatus:
        status === "failed" ? "not_started" : "wallet_operation_unknown",
      errorCode,
      errorMessage,
    });
    return { task };
  }

  private update(id: string, values: TaskUpdate) {
    return updateTask(this.db, id, values, this.now());
  }

  private markPending(taskId: string, reason: string, resultJson?: string) {
    this.update(taskId, {
      status: "pending_reconciliation",
      providerStatus: reason,
      errorCode: "reconciliation_required",
      errorMessage: "Custom model task requires reconciliation",
      ...(resultJson === undefined ? {} : { resultJson }),
    });
  }

  private revoke(token: string) {
    this.db
      .prepare(
        "UPDATE model_capabilities SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(this.now(), hashToken(token));
  }
}

type CapabilityRow = {
  task_id: string;
  expires_at: number;
  status: TaskStatus;
};

function customRequestHash(
  request: ModelRequest,
  entry: CatalogEntry,
  scriptHash: string,
) {
  return createHash("sha256")
    .update(`${baseRequestHash(request, entry)}:${scriptHash}`)
    .digest("hex");
}

function isActive(status: TaskStatus) {
  return status === "created" || status === "held" || status === "running";
}
