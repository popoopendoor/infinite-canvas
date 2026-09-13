import { readFile } from "node:fs/promises";

import { BridgeClient } from "./billing/bridge-client.js";
import {
  listPendingTasks,
  reconcileTask,
  type ReconciliationAction,
} from "./billing/reconciliation.js";
import { assertProductionConfig, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

type Options = {
  list: boolean;
  taskId?: string;
  action?: ReconciliationAction;
  resultFile?: string;
};

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const config = loadConfig();
  assertProductionConfig(config);
  const db = openDatabase(config.databasePath);
  try {
    if (options.list) {
      console.log(
        JSON.stringify(listPendingTasks(db).map(publicTask), null, 2),
      );
      return;
    }
    if (!options.taskId || !options.action) throw new Error(usage());
    const resultJson = options.resultFile
      ? await readResult(options.resultFile)
      : undefined;
    const task = await reconcileTask(
      db,
      new BridgeClient(config),
      options.taskId,
      options.action,
      resultJson,
    );
    console.log(JSON.stringify(publicTask(task), null, 2));
  } finally {
    db.close();
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = { list: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--list") options.list = true;
    else if (value === "--task") options.taskId = args[++index];
    else if (value === "--action") {
      const action = args[++index];
      if (action !== "capture" && action !== "release")
        throw new Error(usage());
      options.action = action;
    } else if (value === "--result-file") options.resultFile = args[++index];
    else throw new Error(usage());
  }
  if (options.list && (options.taskId || options.action || options.resultFile))
    throw new Error(usage());
  if (options.action === "release" && options.resultFile)
    throw new Error(usage());
  return options;
}

async function readResult(path: string) {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  return JSON.stringify(value);
}

function publicTask(task: Awaited<ReturnType<typeof reconcileTask>>) {
  return {
    id: task.id,
    userId: task.userId,
    modelId: task.modelId,
    capability: task.capability,
    amount: task.amount,
    priceVersion: task.priceVersion,
    status: task.status,
    providerStatus: task.providerStatus,
    errorCode: task.errorCode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function usage() {
  return "Usage: reconcile --list | --task <id> --action capture|release [--result-file <path>]";
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Reconciliation failed",
  );
  process.exitCode = 1;
});
