import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { BridgeClient, WalletUnknownError } from "./bridge-client.js";

function config() {
  return loadConfig({
    BRIDGE_URL: "https://forum.example.test/api",
    BRIDGE_TOKEN: "bridge-secret",
  });
}

test("bridge authentication uses a header that does not collide with OAuth", async () => {
  let request: Request | undefined;
  const bridge = new BridgeClient(config(), async (input, init) => {
    request = new Request(input, init);
    return Response.json({ ok: true, balance: 7 });
  });

  assert.equal(await bridge.balance("42"), 7);
  assert.equal(request?.headers.get("x-canvas-bridge-token"), "bridge-secret");
  assert.equal(request?.headers.get("authorization"), null);
});

test("known wallet rejection is returned as a conflict", async () => {
  const bridge = new BridgeClient(config(), async () =>
    Response.json(
      { ok: false, error: "insufficient_balance" },
      { status: 409 },
    ),
  );
  await assert.rejects(
    bridge.hold({
      userId: "42",
      taskId: "task-1",
      amount: 3,
      requestHash: "a".repeat(64),
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 409 &&
      error.code === "conflict",
  );
});

test("wallet write network failure is unknown, not a safe refund", async () => {
  const bridge = new BridgeClient(config(), async () => {
    throw new Error("network down");
  });
  await assert.rejects(
    bridge.capture({
      userId: "42",
      taskId: "task-1",
      amount: 3,
      requestHash: "a".repeat(64),
    }),
    WalletUnknownError,
  );
});

test("invalid wallet mutation responses are treated as unknown", async () => {
  const bridge = new BridgeClient(config(), async () =>
    Response.json({ ok: true, status: "held" }),
  );
  await assert.rejects(
    bridge.hold({
      userId: "42",
      taskId: "task-1",
      amount: 3,
      requestHash: "a".repeat(64),
    }),
    WalletUnknownError,
  );
});

test("wallet mutation status must match the requested operation", async () => {
  const bridge = new BridgeClient(config(), async () =>
    Response.json({ ok: true, ledgerId: "ledger-1", status: "captured" }),
  );
  await assert.rejects(
    bridge.hold({
      userId: "42",
      taskId: "task-1",
      amount: 3,
      requestHash: "a".repeat(64),
    }),
    WalletUnknownError,
  );
});

test("invalid wallet balances fail closed", async () => {
  const bridge = new BridgeClient(config(), async () =>
    Response.json({ ok: true, balance: 1.5 }),
  );
  await assert.rejects(
    bridge.balance("42"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 503 &&
      error.code === "wallet_unavailable",
  );
});
