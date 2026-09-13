import type { Database } from "../db.js";
import { HttpError } from "../errors.js";
import { BridgeClient } from "./bridge-client.js";
import {
  getTaskById,
  mapTask,
  updateTask,
  type TaskRecord,
  type TaskRow,
} from "./task-record.js";

export type ReconciliationAction = "capture" | "release";

export async function reconcileTask(
  db: Database,
  bridge: BridgeClient,
  taskId: string,
  action: ReconciliationAction,
  resultJson?: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
) {
  const task = getTaskById(db, taskId);
  if (task.status !== "pending_reconciliation")
    throw new HttpError(
      409,
      "conflict",
      "Only pending tasks can be reconciled",
    );

  if (action === "capture") {
    const output = resultJson ?? task.resultJson;
    if (output === null || output === undefined)
      throw new HttpError(
        409,
        "conflict",
        "A confirmed provider result is required to capture",
      );
    const capture = await bridge.capture(walletInput(task));
    return updateTask(
      db,
      task.id,
      {
        status: "succeeded",
        providerStatus: "reconciled_capture",
        captureLedgerId: String(capture.ledgerId),
        resultJson: output,
        errorCode: null,
        errorMessage: null,
      },
      now(),
    );
  }

  const release = await bridge.release(walletInput(task));
  return updateTask(
    db,
    task.id,
    {
      status: "failed",
      providerStatus: "reconciled_release",
      releaseLedgerId: String(release.ledgerId),
    },
    now(),
  );
}

export function listPendingTasks(db: Database) {
  return (
    db
      .prepare(
        "SELECT * FROM model_tasks WHERE status = 'pending_reconciliation' ORDER BY created_at ASC",
      )
      .all() as TaskRow[]
  ).map(mapTask);
}

function walletInput(task: TaskRecord) {
  return {
    userId: task.userId,
    taskId: task.id,
    amount: task.amount,
    requestHash: task.requestHash,
  };
}
