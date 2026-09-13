import assert from "node:assert/strict";
import test from "node:test";

import type { AuthUser } from "../auth/oauth.js";
import { openDatabase } from "../db.js";
import { HttpError } from "../errors.js";
import type { ProviderExecutor } from "../provider/executor.js";
import type { BridgeClient } from "./bridge-client.js";
import type { CatalogEntry, ModelRequest } from "./catalog.js";
import { CustomCapabilityService } from "./custom-capability.js";

const user: AuthUser = {
  id: "42",
  username: "alice",
  displayName: "Alice",
  avatarUrl: "",
};

const entry: CatalogEntry = {
  id: "custom-image",
  capability: "image",
  provider: "generic",
  baseUrl: "https://provider.example.test",
  priceVersion: "2026-09-07",
  price: 3,
};

const request: ModelRequest = {
  modelId: entry.id,
  capability: entry.capability,
  prompt: "a lighthouse",
  params: { size: "1024x1024" },
  references: [],
  idempotencyKey: "custom-request-001",
  apiKeyEnvelope: "opaque-envelope",
};

test("custom capability holds, proxies through its task, and captures once", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => 1_000,
  );

  const grant = await service.start(user, request, entry, "a".repeat(64));
  assert.equal(grant.task.status, "running");
  assert.ok(grant.token);
  assert.equal(wallet.holds.length, 1);
  assert.equal(service.active(user.id, grant.token || "").id, grant.task.id);

  const completed = await service.complete(user.id, grant.token || "", {
    url: "https://cdn.example.test/result.png",
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(wallet.captures.length, 1);
  const replayed = await service.complete(user.id, grant.token || "", {
    url: "https://cdn.example.test/different.png",
  });
  assert.equal(replayed.id, completed.id);
  assert.equal(replayed.status, "succeeded");
  assert.equal(wallet.captures.length, 1);
  await assert.rejects(
    async () => service.active(user.id, grant.token || ""),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  db.close();
});

test("custom capability releases a definite script failure and preserves unknown work", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  let now = 1_000;
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => now,
    10,
  );

  const failed = await service.start(user, request, entry, "b".repeat(64));
  const released = await service.complete(
    user.id,
    failed.token || "",
    undefined,
    "provider rejected",
  );
  assert.equal(released.status, "failed");
  assert.equal(wallet.releases.length, 1);

  const pending = await service.start(
    user,
    { ...request, idempotencyKey: "custom-request-002" },
    entry,
    "c".repeat(64),
  );
  now += 11;
  assert.throws(
    () => service.active(user.id, pending.token || ""),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  const task = db
    .prepare("SELECT status FROM model_tasks WHERE id = ?")
    .get(pending.task.id) as { status: string };
  assert.equal(task.status, "pending_reconciliation");
  assert.equal(wallet.releases.length, 1);
  db.close();
});

test("expired capabilities wait for every grant before requiring reconciliation", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  let now = 1_000;
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => now,
    10,
  );

  const first = await service.start(user, request, entry, "b".repeat(64));
  now += 5;
  const second = await service.start(user, request, entry, "b".repeat(64));
  now += 6;

  assert.equal(service.expire(), 0);
  assert.equal(taskStatus(db, first.task.id), "running");
  assert.equal(service.active(user.id, second.token || "").id, first.task.id);

  now += 5;
  assert.equal(service.expire(), 1);
  assert.equal(taskStatus(db, first.task.id), "pending_reconciliation");
  await assert.rejects(
    async () => service.active(user.id, second.token || ""),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  assert.equal(wallet.releases.length, 0);
  db.close();
});

test("abandoning one capability leaves another active grant running", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => 1_000,
  );

  const first = await service.start(user, request, entry, "c".repeat(64));
  const second = await service.start(user, request, entry, "c".repeat(64));

  assert.equal(service.abandon(user.id, first.token || "")?.status, "running");
  assert.equal(service.active(user.id, second.token || "").id, first.task.id);
  assert.equal(
    service.abandon(user.id, second.token || "")?.status,
    "pending_reconciliation",
  );
  assert.equal(wallet.releases.length, 0);
  db.close();
});

test("using an expired capability does not interrupt another active grant", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  let now = 1_000;
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => now,
    10,
  );

  const first = await service.start(user, request, entry, "d".repeat(64));
  now += 5;
  const second = await service.start(user, request, entry, "d".repeat(64));
  now += 6;

  assert.throws(
    () => service.active(user.id, first.token || ""),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(taskStatus(db, first.task.id), "running");

  const completed = await service.complete(user.id, second.token || "", {
    text: "done",
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(wallet.captures.length, 1);
  db.close();
});

test("custom completion retains a confirmed result when capture needs reconciliation", async () => {
  const wallet = fakeBridge();
  wallet.capture = async (input: unknown) => {
    wallet.captures.push(input);
    throw new Error("wallet unavailable");
  };
  const db = openDatabase(":memory:");
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => 1_000,
  );
  const grant = await service.start(user, request, entry, "a".repeat(64));

  await assert.rejects(
    service.complete(user.id, grant.token || "", {
      url: "https://cdn.example.test/result.png",
    }),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );

  const task = db
    .prepare("SELECT status, result_json FROM model_tasks WHERE id = ?")
    .get(grant.task.id) as { status: string; result_json: string | null };
  assert.equal(task.status, "pending_reconciliation");
  assert.equal(
    task.result_json,
    JSON.stringify({ url: "https://cdn.example.test/result.png" }),
  );
  db.close();
});

test("capability setup failure releases the hold instead of leaving a charged task", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TRIGGER reject_capability BEFORE INSERT ON model_capabilities
    BEGIN
      SELECT RAISE(FAIL, 'capability unavailable');
    END;
  `);
  const service = new CustomCapabilityService(
    db,
    wallet,
    provider(),
    () => 1_000,
  );

  const grant = await service.start(user, request, entry, "d".repeat(64));
  assert.equal(grant.task.status, "failed");
  assert.equal(wallet.holds.length, 1);
  assert.equal(wallet.releases.length, 1);
  assert.equal(wallet.captures.length, 0);
  assert.equal(grant.task.releaseLedgerId, "ledger-1");
  db.close();
});

test("concurrent capability starts share one task and one hold", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  const service = new CustomCapabilityService(db, wallet, provider());
  const [first, second] = await Promise.all([
    service.start(user, request, entry, "e".repeat(64)),
    service.start(user, request, entry, "e".repeat(64)),
  ]);

  assert.equal(first.task.id, second.task.id);
  assert.ok(first.token);
  assert.ok(second.token);
  assert.equal(wallet.holds.length, 1);
  db.close();
});

test("concurrent capability starts reject a different script hash", async () => {
  const wallet = fakeBridge();
  const db = openDatabase(":memory:");
  let resolveValidation!: () => void;
  const validation = new Promise<void>((resolve) => {
    resolveValidation = resolve;
  });
  const service = new CustomCapabilityService(db, wallet, {
    validate: async () => validation,
    execute: async () => ({ providerStatus: "unused", output: null }),
  });
  const first = service.start(user, request, entry, "f".repeat(64));
  await Promise.resolve();

  await assert.rejects(
    service.start(user, request, entry, "a".repeat(64)),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  resolveValidation();
  await first;
  db.close();
});

function fakeBridge() {
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
  } as unknown as BridgeClient & {
    holds: unknown[];
    captures: unknown[];
    releases: unknown[];
  };
  return wallet;
}

function provider() {
  return {
    validate: async () => undefined,
    execute: async () => ({ providerStatus: "unused", output: null }),
  } satisfies ProviderExecutor;
}

function taskStatus(db: ReturnType<typeof openDatabase>, id: string) {
  return (
    db.prepare("SELECT status FROM model_tasks WHERE id = ?").get(id) as {
      status: string;
    }
  ).status;
}
