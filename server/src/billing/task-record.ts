import { randomUUID } from "node:crypto";

import type { AuthUser } from "../auth/oauth.js";
import { type Database, recordReconciliation } from "../db.js";
import { HttpError } from "../errors.js";
import type { CatalogEntry, ModelRequest } from "./catalog.js";

export type TaskStatus =
  | "created"
  | "held"
  | "running"
  | "succeeded"
  | "failed"
  | "pending_reconciliation";

export type TaskRecord = {
  id: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  modelId: string;
  capability: string;
  paramsJson: string;
  priceVersion: string;
  amount: number;
  status: TaskStatus;
  providerStatus: string | null;
  holdLedgerId: string | null;
  captureLedgerId: string | null;
  releaseLedgerId: string | null;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TaskRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  model_id: string;
  capability: string;
  params_json: string;
  price_version: string;
  amount: number;
  status: TaskStatus;
  provider_status: string | null;
  hold_ledger_id: string | null;
  capture_ledger_id: string | null;
  release_ledger_id: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

export type TaskUpdate = Partial<
  Pick<
    TaskRecord,
    | "status"
    | "providerStatus"
    | "holdLedgerId"
    | "captureLedgerId"
    | "releaseLedgerId"
    | "resultJson"
    | "errorCode"
    | "errorMessage"
  >
>;

export function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    modelId: row.model_id,
    capability: row.capability,
    paramsJson: row.params_json,
    priceVersion: row.price_version,
    amount: row.amount,
    status: row.status,
    providerStatus: row.provider_status,
    holdLedgerId: row.hold_ledger_id,
    captureLedgerId: row.capture_ledger_id,
    releaseLedgerId: row.release_ledger_id,
    resultJson: row.result_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findTask(db: Database, userId: string, idempotencyKey: string) {
  const row = db
    .prepare(
      "SELECT * FROM model_tasks WHERE user_id = ? AND idempotency_key = ?",
    )
    .get(userId, idempotencyKey) as TaskRow | undefined;
  return row ? mapTask(row) : null;
}

export function getTask(db: Database, userId: string, id: string) {
  const task = getTaskById(db, id);
  if (task.userId !== userId)
    throw new HttpError(404, "not_found", "Model task not found");
  return task;
}

export function getTaskById(db: Database, id: string) {
  const row = db.prepare("SELECT * FROM model_tasks WHERE id = ?").get(id) as
    TaskRow | undefined;
  if (!row) throw new HttpError(404, "not_found", "Model task not found");
  return mapTask(row);
}

export function insertTask(
  db: Database,
  user: AuthUser,
  request: ModelRequest,
  entry: CatalogEntry,
  requestHash: string,
  params: Record<string, unknown>,
  providerStatus: string | null,
  now: number,
): { task: TaskRecord; owner: boolean } {
  const id = randomUUID();
  try {
    db.prepare(
      "INSERT INTO model_tasks (id, user_id, idempotency_key, request_hash, model_id, capability, params_json, price_version, amount, status, provider_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)",
    ).run(
      id,
      user.id,
      request.idempotencyKey,
      requestHash,
      entry.id,
      entry.capability,
      JSON.stringify(params),
      entry.priceVersion,
      entry.price,
      providerStatus,
      now,
      now,
    );
  } catch {
    const existing = findTask(db, user.id, request.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new HttpError(
          409,
          "conflict",
          "Idempotency key is already bound to a different request",
        );
      return { task: existing, owner: false };
    }
    throw new HttpError(
      503,
      "service_unavailable",
      "Could not create model task",
    );
  }
  return { task: getTask(db, user.id, id), owner: true };
}

export function updateTask(
  db: Database,
  id: string,
  values: TaskUpdate,
  now: number,
) {
  const fields = [
    ["status", values.status],
    ["provider_status", values.providerStatus],
    ["hold_ledger_id", values.holdLedgerId],
    ["capture_ledger_id", values.captureLedgerId],
    ["release_ledger_id", values.releaseLedgerId],
    ["result_json", values.resultJson],
    ["error_code", values.errorCode],
    ["error_message", values.errorMessage],
  ].filter(([, value]) => value !== undefined) as Array<[string, unknown]>;
  if (!fields.length) throw new Error("Task update is empty");

  db.prepare(
    `UPDATE model_tasks SET ${fields.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...fields.map(([, value]) => value), now, id);
  if (values.status === "pending_reconciliation")
    recordReconciliation(db, id, values.errorCode || "unknown", now);

  const row = db.prepare("SELECT * FROM model_tasks WHERE id = ?").get(id) as
    TaskRow | undefined;
  if (!row)
    throw new HttpError(500, "internal_error", "Model task disappeared");
  return mapTask(row);
}
