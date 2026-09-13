import type { Database } from "../db.js";
import { HttpError } from "../errors.js";
import type { AuthUser } from "../auth/oauth.js";
import {
  requestHash as calculateRequestHash,
  type CatalogEntry,
  type ModelRequest,
} from "./catalog.js";
import { BridgeClient, WalletUnknownError } from "./bridge-client.js";
import type { ProviderExecutor } from "../provider/executor.js";
import {
  findTask,
  getTask,
  insertTask,
  updateTask,
  type TaskRecord,
  type TaskUpdate,
} from "./task-record.js";

type BatchTaskInput = {
  request: ModelRequest;
  entry: CatalogEntry;
};

type BatchStatus =
  "succeeded" | "failed" | "partial" | "pending_reconciliation";

type BatchResult = {
  status: BatchStatus;
  tasks: TaskRecord[];
};

export class BillingTaskService {
  constructor(
    private readonly db: Database,
    private readonly bridge: BridgeClient,
    private readonly provider: ProviderExecutor,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async execute(user: AuthUser, request: ModelRequest, entry: CatalogEntry) {
    const requestHash = calculateRequestHash(request, entry);
    const existing = this.find(user.id, request.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new HttpError(
          409,
          "conflict",
          "Idempotency key is already bound to a different request",
        );
      return existing;
    }
    const { task, owner } = this.insert(user, request, entry, requestHash);
    if (!owner) return task;
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
        holdLedgerId: String(hold.ledgerId),
      });
      this.update(task.id, { status: "running" });
      const result = await this.provider.execute(entry, request);
      let captureLedgerId = "";
      try {
        const capture = await this.bridge.capture({
          userId: user.id,
          taskId: task.id,
          amount: entry.price,
          requestHash,
        });
        captureLedgerId = String(capture.ledgerId);
      } catch {
        return this.update(task.id, {
          status: "pending_reconciliation",
          providerStatus: "succeeded_capture_unknown",
          resultJson: JSON.stringify(result.output),
          errorCode: "capture_unknown",
          errorMessage:
            "Provider succeeded but wallet capture requires reconciliation",
        });
      }
      return this.update(task.id, {
        status: "succeeded",
        providerStatus: result.providerStatus,
        captureLedgerId,
        resultJson: JSON.stringify(result.output),
      });
    } catch (error) {
      if (error instanceof WalletUnknownError) {
        return this.update(task.id, {
          status: "pending_reconciliation",
          providerStatus: held ? "wallet_operation_unknown" : "hold_unknown",
          errorCode: "wallet_operation_unknown",
          errorMessage:
            "Wallet operation result is unknown; reconciliation is required",
        });
      }
      if (error instanceof Error && error.name === "ProviderUnknownError") {
        return this.update(task.id, {
          status: "pending_reconciliation",
          providerStatus: "unknown",
          errorCode: "provider_unknown",
          errorMessage:
            "Provider result is unknown; reconciliation is required",
        });
      }
      if (!held) {
        const failed = this.update(task.id, {
          status: "failed",
          providerStatus: "not_started",
          errorCode: errorCode(error),
          errorMessage: safeMessage(error),
        });
        if (error instanceof HttpError) throw error;
        return failed;
      }
      try {
        const release = await this.bridge.release({
          userId: user.id,
          taskId: task.id,
          amount: entry.price,
          requestHash,
        });
        return this.update(task.id, {
          status: "failed",
          providerStatus: "failed",
          releaseLedgerId: String(release.ledgerId),
          errorCode: errorCode(error),
          errorMessage: safeMessage(error),
        });
      } catch {
        return this.update(task.id, {
          status: "pending_reconciliation",
          providerStatus: "wallet_compensation_required",
          errorCode: "compensation_required",
          errorMessage:
            "Provider failed but wallet compensation requires reconciliation",
        });
      }
    }
  }

  async executeBatch(
    user: AuthUser,
    inputs: BatchTaskInput[],
  ): Promise<BatchResult> {
    const keys = new Set<string>();
    for (const { request, entry } of inputs) {
      if (keys.has(request.idempotencyKey))
        throw new HttpError(
          409,
          "conflict",
          "Batch contains a duplicate idempotency key",
        );
      keys.add(request.idempotencyKey);
      const existing = this.find(user.id, request.idempotencyKey);
      if (
        existing &&
        existing.requestHash !== calculateRequestHash(request, entry)
      )
        throw new HttpError(
          409,
          "conflict",
          "Idempotency key is already bound to a different request",
        );
    }

    const tasks = await Promise.all(
      inputs.map(async ({ request, entry }) => {
        try {
          return await this.execute(user, request, entry);
        } catch (error) {
          const existing = this.find(user.id, request.idempotencyKey);
          if (
            error instanceof HttpError &&
            existing?.requestHash === calculateRequestHash(request, entry)
          )
            return existing;
          throw error;
        }
      }),
    );
    return { status: batchStatus(tasks), tasks };
  }

  find(userId: string, idempotencyKey: string) {
    return findTask(this.db, userId, idempotencyKey);
  }

  get(userId: string, id: string) {
    return getTask(this.db, userId, id);
  }

  private insert(
    user: AuthUser,
    request: ModelRequest,
    entry: CatalogEntry,
    hash: string,
  ): { task: TaskRecord; owner: boolean } {
    return insertTask(
      this.db,
      user,
      request,
      entry,
      hash,
      {
        prompt: request.prompt || "",
        messages: request.messages || [],
        params: request.params,
        references: request.references,
      },
      null,
      this.now(),
    );
  }

  private update(id: string, values: TaskUpdate) {
    return updateTask(this.db, id, values, this.now());
  }
}

function batchStatus(tasks: TaskRecord[]): BatchStatus {
  if (tasks.some((task) => task.status === "pending_reconciliation"))
    return "pending_reconciliation";
  if (tasks.every((task) => task.status === "succeeded")) return "succeeded";
  if (tasks.every((task) => task.status === "failed")) return "failed";
  return "partial";
}

function errorCode(error: unknown) {
  return error instanceof HttpError ? error.code : "provider_failed";
}

function safeMessage(error: unknown) {
  return error instanceof HttpError ? error.message : "Provider request failed";
}
