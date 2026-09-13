import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { HttpError } from "../errors.js";
import {
  ProviderUnknownError,
  type ProviderExecutor,
  type ProviderResult,
} from "../provider/executor.js";
import type { AuthUser } from "../auth/oauth.js";
import { BillingTaskService } from "./tasks.js";
import type { ModelRequest } from "./catalog.js";
import type { BridgeClient } from "./bridge-client.js";
import { WalletUnknownError } from "./bridge-client.js";

const user: AuthUser = {
  id: "42",
  username: "alice",
  displayName: "Alice",
  avatarUrl: "",
};

const entry = {
  id: "text-basic",
  capability: "text" as const,
  provider: "generic" as const,
  baseUrl: "https://provider.example.test",
  model: "text-basic",
  priceVersion: "2026-09-06",
  price: 3,
};

function request(idempotencyKey = "request-001"): ModelRequest {
  return {
    modelId: entry.id,
    capability: entry.capability,
    prompt: "hello",
    params: {},
    references: [],
    idempotencyKey,
  };
}

function bridge(overrides: Partial<FakeBridge> = {}) {
  const wallet = {
    holds: [] as unknown[],
    captures: [] as unknown[],
    releases: [] as unknown[],
    hold: async (input: unknown) => {
      wallet.holds.push(input);
      return { ok: true, ledgerId: "ledger-1", status: "held" as const };
    },
    capture: async (input: unknown) => {
      wallet.captures.push(input);
      return { ok: true, ledgerId: "ledger-1", status: "captured" as const };
    },
    release: async (input: unknown) => {
      wallet.releases.push(input);
      return { ok: true, ledgerId: "ledger-1", status: "released" as const };
    },
    balance: async () => 10,
    ...overrides,
  } as unknown as FakeBridge;
  return wallet;
}

type FakeBridge = Pick<
  BridgeClient,
  "hold" | "capture" | "release" | "balance"
> & {
  holds: unknown[];
  captures: unknown[];
  releases: unknown[];
};

function provider(result: ProviderResult | Error) {
  return {
    execute: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as ProviderExecutor;
}

function service(
  wallet: FakeBridge,
  model: ProviderExecutor,
  now = () => 1_000,
) {
  const db = openDatabase(":memory:");
  return {
    db,
    service: new BillingTaskService(db, wallet, model, now),
  };
}

test("known hold failure is returned as a conflict without a release", async () => {
  const wallet = bridge({
    hold: async (input: unknown) => {
      wallet.holds.push(input);
      throw new HttpError(409, "conflict", "insufficient_balance");
    },
  });
  const { db, service: tasks } = service(
    wallet,
    provider({ providerStatus: "succeeded", output: "unused" }),
  );

  await assert.rejects(
    tasks.execute(user, request(), entry),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );

  const result = tasks.find(user.id, request().idempotencyKey);
  assert.equal(result?.status, "failed");
  assert.equal(result?.providerStatus, "not_started");
  assert.equal(wallet.holds.length, 1);
  assert.equal(wallet.releases.length, 0);
  db.close();
});

test("explicit provider failure releases exactly once", async () => {
  const wallet = bridge();
  const { db, service: tasks } = service(
    wallet,
    provider(new Error("provider rejected")),
  );

  const result = await tasks.execute(user, request(), entry);

  assert.equal(result.status, "failed");
  assert.equal(result.providerStatus, "failed");
  assert.equal(wallet.holds.length, 1);
  assert.equal(wallet.releases.length, 1);
  db.close();
});

test("unknown provider result remains pending without automatic refund", async () => {
  const wallet = bridge();
  const unknown = new ProviderUnknownError();
  const { db, service: tasks } = service(wallet, provider(unknown));

  const result = await tasks.execute(user, request(), entry);

  assert.equal(result.status, "pending_reconciliation");
  assert.equal(result.providerStatus, "unknown");
  assert.equal(wallet.releases.length, 0);
  db.close();
});

test("unknown hold result remains pending without attempting release", async () => {
  const wallet = bridge({
    hold: async (input: unknown) => {
      wallet.holds.push(input);
      throw new WalletUnknownError();
    },
  });
  const { db, service: tasks } = service(
    wallet,
    provider({ providerStatus: "succeeded", output: "unused" }),
  );

  const result = await tasks.execute(user, request(), entry);

  assert.equal(result.status, "pending_reconciliation");
  assert.equal(result.providerStatus, "hold_unknown");
  assert.equal(wallet.releases.length, 0);
  db.close();
});

test("capture failure enters reconciliation without release", async () => {
  const wallet = bridge({
    capture: async (input: unknown) => {
      wallet.captures.push(input);
      throw new Error("wallet unavailable");
    },
  });
  const { db, service: tasks } = service(
    wallet,
    provider({ providerStatus: "succeeded", output: { text: "ok" } }),
  );

  const result = await tasks.execute(user, request(), entry);

  assert.equal(result.status, "pending_reconciliation");
  assert.equal(result.providerStatus, "succeeded_capture_unknown");
  assert.equal(result.resultJson, JSON.stringify({ text: "ok" }));
  assert.equal(wallet.captures.length, 1);
  assert.equal(wallet.releases.length, 0);
  db.close();
});

test("same idempotency key reuses the task and rejects a different request", async () => {
  const wallet = bridge();
  const { db, service: tasks } = service(
    wallet,
    provider({ providerStatus: "succeeded", output: { text: "ok" } }),
  );

  const first = await tasks.execute(user, request(), entry);
  const second = await tasks.execute(user, request(), entry);
  assert.equal(second.id, first.id);
  assert.equal(wallet.holds.length, 1);
  assert.equal(wallet.captures.length, 1);

  await assert.rejects(
    tasks.execute(user, { ...request(), prompt: "different" }, entry),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  await assert.rejects(
    tasks.execute(user, { ...request(), params: { size: "1024x1024" } }, entry),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  db.close();
});

test("batch keeps each billing unit independently accountable", async () => {
  const wallet = bridge();
  const unknown = new ProviderUnknownError();
  const model: ProviderExecutor = {
    execute: async (_entry, request) => {
      if (request.prompt === "failed") throw new Error("provider rejected");
      if (request.prompt === "unknown") throw unknown;
      return { providerStatus: "succeeded", output: { text: "ok" } };
    },
  };
  const { db, service: tasks } = service(wallet, model);

  const result = await tasks.executeBatch(user, [
    { request: request("batch-success"), entry },
    {
      request: { ...request("batch-failed"), prompt: "failed" },
      entry,
    },
    {
      request: { ...request("batch-unknown"), prompt: "unknown" },
      entry,
    },
  ]);

  assert.equal(result.status, "pending_reconciliation");
  assert.deepEqual(
    result.tasks.map((task) => task.status),
    ["succeeded", "failed", "pending_reconciliation"],
  );
  assert.equal(wallet.holds.length, 3);
  assert.equal(wallet.captures.length, 1);
  assert.equal(wallet.releases.length, 1);
  db.close();
});

test("batch rejects duplicate idempotency keys before creating tasks", async () => {
  const wallet = bridge();
  const { db, service: tasks } = service(
    wallet,
    provider({ providerStatus: "succeeded", output: null }),
  );

  await assert.rejects(
    tasks.executeBatch(user, [
      { request: request("batch-duplicate"), entry },
      { request: request("batch-duplicate"), entry },
    ]),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(wallet.holds.length, 0);
  db.close();
});

test("config exposes one provider timeout value", () => {
  const config = loadConfig();
  assert.equal(config.modelProviderTimeoutMs, 120_000);
});
