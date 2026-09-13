import assert from "node:assert/strict";
import test from "node:test";

import type { AuthUser } from "../auth/oauth.js";
import { openDatabase } from "../db.js";
import { HttpError } from "../errors.js";
import type { BridgeClient } from "./bridge-client.js";
import type { CatalogEntry, ModelRequest } from "./catalog.js";
import { reconcileTask } from "./reconciliation.js";
import { insertTask, updateTask } from "./task-record.js";

const user: AuthUser = {
  id: "42",
  username: "alice",
  displayName: "Alice",
  avatarUrl: "",
};

const entry: CatalogEntry = {
  id: "text-basic",
  capability: "text",
  provider: "generic",
  baseUrl: "https://provider.example.test",
  priceVersion: "2026-09-08",
  price: 3,
};

const request: ModelRequest = {
  modelId: entry.id,
  capability: entry.capability,
  prompt: "hello",
  params: {},
  references: [],
  idempotencyKey: "reconciliation-request",
};

test("reconciliation captures a confirmed result exactly once", async () => {
  const db = openDatabase(":memory:");
  const task = pendingTask(db, JSON.stringify({ text: "done" }));
  const wallet = fakeBridge();

  const reconciled = await reconcileTask(
    db,
    wallet,
    task.id,
    "capture",
    undefined,
    () => 2_000,
  );

  assert.equal(reconciled.status, "succeeded");
  assert.equal(reconciled.providerStatus, "reconciled_capture");
  assert.equal(reconciled.captureLedgerId, "ledger-capture");
  assert.equal(reconciled.resultJson, JSON.stringify({ text: "done" }));
  assert.equal(reconciled.errorCode, null);
  assert.equal(wallet.captures.length, 1);
  db.close();
});

test("reconciliation refuses capture without a confirmed provider result", async () => {
  const db = openDatabase(":memory:");
  const task = pendingTask(db, null);
  const wallet = fakeBridge();

  await assert.rejects(
    reconcileTask(db, wallet, task.id, "capture"),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(wallet.captures.length, 0);
  db.close();
});

test("reconciliation releases a confirmed failure exactly once", async () => {
  const db = openDatabase(":memory:");
  const task = pendingTask(db, null);
  const wallet = fakeBridge();

  const reconciled = await reconcileTask(
    db,
    wallet,
    task.id,
    "release",
    undefined,
    () => 2_000,
  );

  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.providerStatus, "reconciled_release");
  assert.equal(reconciled.releaseLedgerId, "ledger-release");
  assert.equal(wallet.releases.length, 1);
  db.close();
});

function pendingTask(
  db: ReturnType<typeof openDatabase>,
  resultJson: string | null,
) {
  const inserted = insertTask(
    db,
    user,
    request,
    entry,
    "a".repeat(64),
    { prompt: request.prompt, messages: [], params: {}, references: [] },
    "succeeded_capture_unknown",
    1_000,
  ).task;
  return updateTask(
    db,
    inserted.id,
    {
      status: "pending_reconciliation",
      resultJson,
      errorCode: "capture_unknown",
      errorMessage: "Wallet capture requires reconciliation",
    },
    1_000,
  );
}

function fakeBridge() {
  const wallet = {
    captures: [] as unknown[],
    releases: [] as unknown[],
    capture: async (input: unknown) => {
      wallet.captures.push(input);
      return {
        ok: true,
        ledgerId: "ledger-capture",
        status: "captured" as const,
      };
    },
    release: async (input: unknown) => {
      wallet.releases.push(input);
      return {
        ok: true,
        ledgerId: "ledger-release",
        status: "released" as const,
      };
    },
  } as unknown as BridgeClient & {
    captures: unknown[];
    releases: unknown[];
  };
  return wallet;
}
