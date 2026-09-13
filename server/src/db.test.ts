import assert from "node:assert/strict";
import test from "node:test";
import { markInFlightTasksForReconciliation, openDatabase } from "./db.js";

test("in-flight tasks are moved to reconciliation on restart", () => {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO model_tasks (id, user_id, idempotency_key, request_hash, model_id, capability, params_json, price_version, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "task-1",
    "42",
    "request-001",
    "a".repeat(64),
    "model",
    "text",
    "{}",
    "v1",
    1,
    "running",
    1,
    1,
  );

  assert.equal(markInFlightTasksForReconciliation(db, 100), 1);
  const row = db
    .prepare(
      "SELECT status, provider_status, error_code, updated_at FROM model_tasks WHERE id = ?",
    )
    .get("task-1") as Record<string, unknown>;
  assert.deepEqual(row, {
    status: "pending_reconciliation",
    provider_status: "bff_restarted",
    error_code: "bff_restarted",
    updated_at: 100,
  });
  assert.deepEqual(
    db.prepare("SELECT task_id, reason FROM reconciliation_records").all(),
    [{ task_id: "task-1", reason: "bff_restarted" }],
  );
  assert.equal(markInFlightTasksForReconciliation(db, 200), 0);
  db.close();
});
