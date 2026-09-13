import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { HttpError } from "./errors.js";
import { createApp } from "./http.js";
import { createLogger } from "./logger.js";
import { SessionStore } from "./auth/session.js";
import type { BridgeClient } from "./billing/bridge-client.js";
import type { ProviderExecutor } from "./provider/executor.js";

type RunningServer = { server: Server; url: string };

test("HTTP auth flow establishes, protects, and revokes a session", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
  });
  const appServer = await startApp(provider.url);
  try {
    const login = await fetch(
      `${appServer.url}/auth/login?returnTo=%2Fcanvas%3Ftab%3D2`,
      { redirect: "manual" },
    );
    assert.equal(login.status, 302);
    const transactionCookie = responseCookie(login, "canvas_oauth_transaction");
    const authorization = new URL(login.headers.get("location") || "");
    assert.equal(authorization.origin, provider.url);
    assert.ok(authorization.searchParams.get("state"));

    const callback = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=${encodeURIComponent(authorization.searchParams.get("state") || "")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/canvas?tab=2");
    const sessionCookie = responseCookie(callback, "canvas_session");

    const session = await fetch(`${appServer.url}/auth/session`, {
      headers: { cookie: sessionCookie },
    });
    assert.deepEqual(await session.json(), {
      authenticated: true,
      user: {
        id: "42",
        username: "alice",
        displayName: "Alice",
        avatarUrl: "",
      },
    });
    const models = await fetch(`${appServer.url}/api/models`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(models.status, 200);
    const modelPayload = (await models.json()) as {
      catalogRelease?: Record<string, unknown>;
      models?: unknown[];
    };
    assert.equal(modelPayload.catalogRelease?.id, 1);
    assert.match(
      String(modelPayload.catalogRelease?.contentHash),
      /^[a-f0-9]{64}$/,
    );
    assert.equal(typeof modelPayload.catalogRelease?.activatedAt, "number");
    assert.deepEqual(modelPayload.models, []);

    const rejectedLogout = await fetch(`${appServer.url}/auth/logout`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "https://attacker.example" },
    });
    assert.equal(rejectedLogout.status, 403);

    const logout = await fetch(`${appServer.url}/auth/logout`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "http://127.0.0.1:3000" },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(
      await (
        await fetch(`${appServer.url}/auth/session`, {
          headers: { cookie: sessionCookie },
        })
      ).json(),
      {
        authenticated: false,
      },
    );
    assert.equal(
      (
        await fetch(`${appServer.url}/api/models`, {
          headers: { cookie: sessionCookie },
        })
      ).status,
      401,
    );
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP model catalog exposes managed routing metadata without provider keys", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
  });
  const appServer = await startApp(provider.url, {
    MODEL_CATALOG_JSON: JSON.stringify([
      {
        id: "managed-text",
        capability: "text",
        provider: "openai",
        baseUrl: "https://api.example.test/v1",
        model: "published-text",
        priceVersion: "v1",
        price: 2,
      },
      {
        id: "managed-image",
        capability: "image",
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "published-image",
        priceVersion: "v1",
        price: 3,
      },
    ]),
    MODEL_PROVIDER_KEYS_JSON: JSON.stringify({
      "managed-text": "provider-key",
      "managed-image": "provider-key",
    }),
  });
  try {
    const sessionCookie = await authenticate(appServer);
    const response = await fetch(`${appServer.url}/api/models`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models?: unknown };
    assert.deepEqual(payload.models, [
      {
        id: "managed-image",
        capability: "image",
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiFormat: "gemini",
        model: "published-image",
        priceVersion: "v1",
        price: 3,
        credentialMode: "managed",
      },
      {
        id: "managed-text",
        capability: "text",
        provider: "openai",
        baseUrl: "https://api.example.test/v1",
        apiFormat: "openai",
        model: "published-text",
        priceVersion: "v1",
        price: 2,
        credentialMode: "managed",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(payload), /provider-key/);
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP OAuth callback rejects a state paired with another browser transaction", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
  });
  const appServer = await startApp(provider.url);
  try {
    const first = await fetch(`${appServer.url}/auth/login`, {
      redirect: "manual",
    });
    const firstCookie = responseCookie(first, "canvas_oauth_transaction");
    const firstAuthorization = new URL(first.headers.get("location") || "");
    const second = await fetch(`${appServer.url}/auth/login`, {
      redirect: "manual",
    });
    const secondCookie = responseCookie(second, "canvas_oauth_transaction");
    assert.notEqual(firstCookie, secondCookie);
    const callback = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=${encodeURIComponent(firstAuthorization.searchParams.get("state") || "")}`,
      { headers: { cookie: secondCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 303);
    assert.equal(
      callback.headers.get("location"),
      "/login/error?reason=invalid_callback",
    );
    assert.equal(responseCookieIfPresent(callback, "canvas_session"), null);
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP OAuth callback treats a 200 OAuth error as a failed login", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { error: "invalid_grant" },
  });
  const appServer = await startApp(provider.url);
  try {
    const login = await fetch(`${appServer.url}/auth/login`, {
      redirect: "manual",
    });
    const transactionCookie = responseCookie(login, "canvas_oauth_transaction");
    const authorization = new URL(login.headers.get("location") || "");
    const callback = await fetch(
      `${appServer.url}/auth/callback?code=denied&state=${encodeURIComponent(authorization.searchParams.get("state") || "")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 303);
    assert.equal(
      new URL(callback.headers.get("location") || "", appServer.url).pathname,
      "/login/error",
    );
    assert.equal(
      new URL(
        callback.headers.get("location") || "",
        appServer.url,
      ).searchParams.get("reason"),
      "oauth_unavailable",
    );
    assert.equal(responseCookieIfPresent(callback, "canvas_session"), null);
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP OAuth denial consumes its transaction without creating a session", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
  });
  const appServer = await startApp(provider.url);
  try {
    const login = await fetch(`${appServer.url}/auth/login`, {
      redirect: "manual",
    });
    const transactionCookie = responseCookie(login, "canvas_oauth_transaction");
    const authorization = new URL(login.headers.get("location") || "");
    const state = authorization.searchParams.get("state") || "";

    const denial = await fetch(
      `${appServer.url}/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(denial.status, 303);
    assert.equal(
      denial.headers.get("location"),
      "/login/error?reason=oauth_denied",
    );
    assert.equal(responseCookieIfPresent(denial, "canvas_session"), null);

    const replay = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=${encodeURIComponent(state)}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(replay.status, 303);
    assert.equal(
      replay.headers.get("location"),
      "/login/error?reason=invalid_callback",
    );
    assert.equal(responseCookieIfPresent(replay, "canvas_session"), null);
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP OAuth callback rejects an invalid user response without creating a session", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
    userResponse: { id: "not-a-flarum-id", username: "alice" },
  });
  const appServer = await startApp(provider.url);
  try {
    const login = await fetch(`${appServer.url}/auth/login`, {
      redirect: "manual",
    });
    const transactionCookie = responseCookie(login, "canvas_oauth_transaction");
    const authorization = new URL(login.headers.get("location") || "");
    const callback = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=${encodeURIComponent(authorization.searchParams.get("state") || "")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 303);
    assert.equal(
      callback.headers.get("location"),
      "/login/error?reason=oauth_unavailable",
    );
    assert.equal(responseCookieIfPresent(callback, "canvas_session"), null);
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP OAuth callback classifies an upstream timeout as unavailable", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
    tokenDelayMs: 1_100,
  });
  const appServer = await startApp(provider.url, { OAUTH_TIMEOUT_MS: "1000" });
  try {
    const login = await fetch(`${appServer.url}/auth/login`, {
      redirect: "manual",
    });
    const transactionCookie = responseCookie(login, "canvas_oauth_transaction");
    const authorization = new URL(login.headers.get("location") || "");
    const callback = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=${encodeURIComponent(authorization.searchParams.get("state") || "")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 303);
    assert.equal(
      callback.headers.get("location"),
      "/login/error?reason=oauth_unavailable",
    );
    assert.equal(responseCookieIfPresent(callback, "canvas_session"), null);
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP login routes an unavailable OAuth service to the retryable error page", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:3000",
    MODEL_CATALOG_JSON: "[]",
  });
  const db = openDatabase(":memory:");
  const server = createServer(
    createApp({ config, db, logger: createLogger("silent") }),
  );
  await listen(server);
  server.once("close", () => db.close());
  const app = { server, url: `http://127.0.0.1:${addressPort(server)}` };
  try {
    const response = await fetch(`${app.url}/auth/login?returnTo=%2Fcanvas`, {
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/login/error?reason=oauth_unavailable",
    );
    assert.equal(
      responseCookieIfPresent(response, "canvas_oauth_transaction"),
      null,
    );
  } finally {
    await close(app);
  }
});

test("HTTP rate limits OAuth starts and callbacks by client IP", async () => {
  const provider = await startOAuthProvider({
    tokenResponse: { access_token: "provider-token" },
  });
  const appServer = await startApp(provider.url, {
    AUTH_RATE_LIMIT_MAX: "1",
    AUTH_RATE_LIMIT_WINDOW_MS: "60000",
  });
  try {
    const firstLogin = await fetch(`${appServer.url}/auth/login`, {
      headers: { "x-forwarded-for": "203.0.113.1" },
      redirect: "manual",
    });
    assert.equal(firstLogin.status, 302);
    const otherClient = await fetch(`${appServer.url}/auth/login`, {
      headers: { "x-forwarded-for": "203.0.113.2" },
      redirect: "manual",
    });
    assert.equal(otherClient.status, 302);
    const limitedLogin = await fetch(`${appServer.url}/auth/login`, {
      headers: { "x-forwarded-for": "203.0.113.1" },
      redirect: "manual",
    });
    assert.equal(limitedLogin.status, 303);
    assert.equal(
      limitedLogin.headers.get("location"),
      "/login/error?reason=rate_limited",
    );
    assert.equal(limitedLogin.headers.get("retry-after"), "60");
    assert.equal(
      responseCookieIfPresent(limitedLogin, "canvas_oauth_transaction"),
      null,
    );

    const firstCallback = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=unknown`,
      {
        headers: { "x-forwarded-for": "203.0.113.3" },
        redirect: "manual",
      },
    );
    assert.equal(firstCallback.status, 303);
    assert.equal(
      firstCallback.headers.get("location"),
      "/login/error?reason=invalid_callback",
    );
    const limitedCallback = await fetch(
      `${appServer.url}/auth/callback?code=approved&state=unknown`,
      {
        headers: { "x-forwarded-for": "203.0.113.3" },
        redirect: "manual",
      },
    );
    assert.equal(limitedCallback.status, 303);
    assert.equal(
      limitedCallback.headers.get("location"),
      "/login/error?reason=rate_limited",
    );
  } finally {
    await close(appServer);
    await close(provider);
  }
});

test("HTTP model tasks derive catalog pricing and capture an idempotent task once", async () => {
  const capability = await startCapabilityApp();
  const body = {
    modelId: "custom-image",
    capability: "image",
    prompt: "a lighthouse",
    params: { size: "1024x1024" },
    references: [],
    idempotencyKey: "http-model-task-001",
    apiKeyEnvelope: "opaque-browser-envelope",
  };
  try {
    const first = await fetch(`${capability.app.url}/api/model-tasks`, {
      method: "POST",
      headers: {
        cookie: capability.ownerCookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 200);
    const firstPayload = (await first.json()) as {
      task: {
        id: string;
        amount: number;
        priceVersion: string;
        status: string;
      };
    };
    assert.equal(firstPayload.task.amount, 3);
    assert.equal(firstPayload.task.priceVersion, "2026-09-07");
    assert.equal(firstPayload.task.status, "succeeded");

    const second = await fetch(`${capability.app.url}/api/model-tasks`, {
      method: "POST",
      headers: {
        cookie: capability.ownerCookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(second.status, 200);
    const secondPayload = (await second.json()) as { task: { id: string } };
    assert.equal(secondPayload.task.id, firstPayload.task.id);
    assert.equal(capability.wallet.holds.length, 1);
    assert.equal(capability.wallet.captures.length, 1);
  } finally {
    await close(capability.app);
  }
});

test("HTTP managed model tasks are billed without a browser credential", async () => {
  const capability = await startCapabilityApp({
    modelProviderKeys: { "custom-image": "provider-key" },
  });
  try {
    const response = await fetch(`${capability.app.url}/api/model-tasks`, {
      method: "POST",
      headers: {
        cookie: capability.ownerCookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelId: "custom-image",
        capability: "image",
        prompt: "a lighthouse",
        params: {},
        references: [],
        idempotencyKey: "http-managed-task-001",
      }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      task: { status: string; amount: number };
    };
    assert.equal(payload.task.status, "succeeded");
    assert.equal(payload.task.amount, 3);
    assert.equal(capability.wallet.holds.length, 1);
    assert.equal(capability.wallet.captures.length, 1);
    assert.equal(capability.provider.executions.length, 1);
  } finally {
    await close(capability.app);
  }
});

test("HTTP batch tasks keep child statuses and charges independent", async () => {
  const capability = await startCapabilityApp();
  const body = {
    requests: [
      {
        modelId: "custom-image",
        capability: "image",
        prompt: "a lighthouse",
        params: {},
        references: [],
        idempotencyKey: "http-batch-task-001",
        apiKeyEnvelope: "opaque-browser-envelope",
      },
      {
        modelId: "custom-image",
        capability: "image",
        prompt: "a mountain",
        params: {},
        references: [],
        idempotencyKey: "http-batch-task-002",
        apiKeyEnvelope: "opaque-browser-envelope",
      },
    ],
  };
  try {
    const response = await fetch(
      `${capability.app.url}/api/model-task-batches`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      status: string;
      tasks: Array<{ amount: number; status: string }>;
    };
    assert.equal(payload.status, "succeeded");
    assert.deepEqual(
      payload.tasks.map((task) => [task.amount, task.status]),
      [
        [3, "succeeded"],
        [3, "succeeded"],
      ],
    );
    assert.equal(capability.wallet.holds.length, 2);
    assert.equal(capability.wallet.captures.length, 2);

    const replay = await fetch(`${capability.app.url}/api/model-task-batches`, {
      method: "POST",
      headers: {
        cookie: capability.ownerCookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    assert.equal(capability.wallet.holds.length, 2);
    assert.equal(capability.wallet.captures.length, 2);
  } finally {
    await close(capability.app);
  }
});

test("HTTP rejects invalid model requests and known wallet failures", async () => {
  const wallet = fakeBridge();
  wallet.hold = async (input: unknown) => {
    wallet.holds.push(input);
    throw new HttpError(409, "conflict", "insufficient_balance");
  };
  const provider = fakeProvider();
  const capability = await startCapabilityApp({
    wallet,
    provider,
  });
  try {
    const invalid = await fetch(`${capability.app.url}/api/model-tasks`, {
      method: "POST",
      headers: {
        cookie: capability.ownerCookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);

    const rejected = await fetch(`${capability.app.url}/api/model-tasks`, {
      method: "POST",
      headers: {
        cookie: capability.ownerCookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelId: "custom-image",
        capability: "image",
        prompt: "a lighthouse",
        params: {},
        references: [],
        idempotencyKey: "wallet-rejection-001",
        apiKeyEnvelope: "opaque-browser-envelope",
      }),
    });
    assert.equal(rejected.status, 409);
    assert.equal(capability.wallet.holds.length, 1);
    assert.equal(capability.provider.executions.length, 0);
  } finally {
    await close(capability.app);
  }
});

test("HTTP distinguishes session storage failure from an anonymous session", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:3000",
    MODEL_CATALOG_JSON: "[]",
  });
  const db = openDatabase(":memory:");
  const sessions = new SessionStore(db);
  const cookie = `canvas_session=${sessions.create({ id: "42", username: "alice", displayName: "Alice", avatarUrl: "" }).token}`;
  const server = createServer(
    createApp({ config, db, sessions, logger: createLogger("silent") }),
  );
  await listen(server);
  db.close();
  try {
    const response = await fetch(`${serverUrl(server)}/auth/session`, {
      headers: { cookie },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "service_unavailable",
        message: "Authentication service is unavailable",
      },
    });
  } finally {
    await close({ server, url: serverUrl(server) });
  }
});

test("HTTP custom capabilities bind the user, origin, and completion replay", async () => {
  const capability = await startCapabilityApp();
  try {
    const body = {
      modelId: "custom-image",
      capability: "image",
      prompt: "a lighthouse",
      params: { size: "1024x1024" },
      references: [],
      idempotencyKey: "custom-http-request-001",
      apiKeyEnvelope: "opaque-browser-envelope",
      scriptHash: "a".repeat(64),
    };
    const rejected = await fetch(
      `${capability.app.url}/api/model-capabilities`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(rejected.status, 403);

    const started = await fetch(
      `${capability.app.url}/api/model-capabilities`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(started.status, 200);
    const startPayload = (await started.json()) as {
      capability: { token: string };
      target: { baseUrl: string; model: string };
      task: { id: string };
    };
    const token = startPayload.capability.token;
    assert.deepEqual(startPayload.target, {
      baseUrl: "https://provider.example.test",
      model: "custom-image",
    });
    assert.equal(capability.wallet.holds.length, 1);

    const missingHeader = await fetch(
      `${capability.app.url}/api/model-capabilities/request`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(capabilityRequestBody()),
      },
    );
    assert.equal(missingHeader.status, 401);

    const wrongUser = await fetch(
      `${capability.app.url}/api/model-capabilities/request`,
      {
        method: "POST",
        headers: {
          cookie: capability.otherCookie,
          origin: "http://127.0.0.1:3000",
          "x-canvas-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(capabilityRequestBody()),
      },
    );
    assert.equal(wrongUser.status, 401);

    const proxied = await fetch(
      `${capability.app.url}/api/model-capabilities/request`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "x-canvas-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(capabilityRequestBody()),
      },
    );
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), {
      ok: true,
      data: { accepted: true },
    });
    assert.equal(capability.provider.proxies.length, 1);

    const complete = await completeCapability(
      capability.app.url,
      capability.ownerCookie,
      token,
      {
        url: "https://cdn.example.test/result.png",
      },
    );
    assert.equal(complete.status, 200);
    assert.equal(capability.wallet.captures.length, 1);

    const replay = await completeCapability(
      capability.app.url,
      capability.ownerCookie,
      token,
      {
        url: "https://cdn.example.test/different.png",
      },
    );
    assert.equal(replay.status, 200);
    assert.equal(capability.wallet.captures.length, 1);
    assert.deepEqual(
      ((await replay.json()) as { task: { result: unknown } }).task.result,
      {
        url: "https://cdn.example.test/result.png",
      },
    );

    const inactive = await fetch(
      `${capability.app.url}/api/model-capabilities/request`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "x-canvas-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(capabilityRequestBody()),
      },
    );
    assert.equal(inactive.status, 401);
  } finally {
    await close(capability.app);
  }
});

test("HTTP capability abandonment preserves held work for reconciliation", async () => {
  const capability = await startCapabilityApp();
  try {
    const started = await fetch(
      `${capability.app.url}/api/model-capabilities`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelId: "custom-image",
          capability: "image",
          prompt: "a lighthouse",
          params: {},
          references: [],
          idempotencyKey: "custom-abandon-request-001",
          apiKeyEnvelope: "opaque-browser-envelope",
          scriptHash: "a".repeat(64),
        }),
      },
    );
    assert.equal(started.status, 200);
    const token = ((await started.json()) as { capability: { token: string } })
      .capability.token;

    const abandoned = await fetch(
      `${capability.app.url}/api/model-capabilities/abandon`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "x-canvas-capability": token,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(abandoned.status, 200);
    assert.equal(
      ((await abandoned.json()) as { task: { status: string } }).task.status,
      "pending_reconciliation",
    );
    assert.equal(capability.wallet.holds.length, 1);
    assert.equal(capability.wallet.captures.length, 0);
    assert.equal(capability.wallet.releases.length, 0);

    const request = await fetch(
      `${capability.app.url}/api/model-capabilities/request`,
      {
        method: "POST",
        headers: {
          cookie: capability.ownerCookie,
          origin: "http://127.0.0.1:3000",
          "x-canvas-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(capabilityRequestBody()),
      },
    );
    assert.equal(request.status, 401);
  } finally {
    await close(capability.app);
  }
});

test("HTTP quote requires the Canvas origin", async () => {
  const appServer = await startCapabilityApp();
  try {
    const response = await fetch(`${appServer.app.url}/api/quote`, {
      method: "POST",
      headers: {
        cookie: appServer.ownerCookie,
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        modelId: "custom-image",
        capability: "image",
        params: {},
      }),
    });
    assert.equal(response.status, 403);
  } finally {
    await close(appServer.app);
  }
});

async function startApp(
  providerUrl: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<RunningServer> {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:3000",
    FLARUM_BASE_URL: providerUrl,
    OAUTH_CLIENT_ID: "canvas",
    OAUTH_CLIENT_SECRET: "secret",
    OAUTH_AUTHORIZE_PATH: "/oauth/authorize",
    OAUTH_TOKEN_PATH: "/oauth/token",
    OAUTH_USER_PATH: "/api/user",
    MODEL_CATALOG_JSON: "[]",
    ...overrides,
  });
  const db = openDatabase(":memory:");
  const server = createServer(
    createApp({ config, db, logger: createLogger("silent") }),
  );
  await listen(server);
  server.once("close", () => db.close());
  return { server, url: `http://127.0.0.1:${addressPort(server)}` };
}

async function authenticate(appServer: RunningServer) {
  const login = await fetch(`${appServer.url}/auth/login`, {
    redirect: "manual",
  });
  const transactionCookie = responseCookie(login, "canvas_oauth_transaction");
  const authorization = new URL(login.headers.get("location") || "");
  const callback = await fetch(
    `${appServer.url}/auth/callback?code=approved&state=${encodeURIComponent(authorization.searchParams.get("state") || "")}`,
    { headers: { cookie: transactionCookie }, redirect: "manual" },
  );
  return responseCookie(callback, "canvas_session");
}

async function startOAuthProvider(options: {
  tokenResponse: Record<string, unknown>;
  userResponse?: unknown;
  tokenDelayMs?: number;
}): Promise<RunningServer> {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "provider-code");
      callback.searchParams.set("state", url.searchParams.get("state") || "");
      response.writeHead(302, { location: callback.toString() }).end();
      return;
    }
    if (url.pathname === "/oauth/token") {
      response.setHeader("content-type", "application/json");
      if (options.tokenDelayMs) {
        setTimeout(
          () => response.end(JSON.stringify(options.tokenResponse)),
          options.tokenDelayMs,
        );
      } else response.end(JSON.stringify(options.tokenResponse));
      return;
    }
    if (url.pathname === "/api/user") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          options.userResponse || {
            id: 42,
            username: "alice",
            displayName: "Alice",
          },
        ),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server);
  return { server, url: `http://127.0.0.1:${addressPort(server)}` };
}

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function addressPort(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server did not bind to a TCP port");
  return address.port;
}

function serverUrl(server: Server) {
  return `http://127.0.0.1:${addressPort(server)}`;
}

function responseCookie(response: Response, name: string) {
  const cookie = responseCookieIfPresent(response, name);
  assert.ok(cookie, `Response did not set ${name}`);
  return cookie;
}

function responseCookieIfPresent(response: Response, name: string) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() || [headers.get("set-cookie") || ""];
  for (const value of values) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}

function capabilityRequestBody() {
  return {
    method: "POST",
    url: "/v1/images/generations",
    headers: { authorization: "Bearer browser-value" },
    data: { prompt: "a lighthouse" },
    apiKeyEnvelope: "opaque-browser-envelope",
  };
}

function completeCapability(
  baseUrl: string,
  cookie: string,
  token: string,
  result: unknown,
) {
  return fetch(`${baseUrl}/api/model-capabilities/complete`, {
    method: "POST",
    headers: {
      cookie,
      origin: "http://127.0.0.1:3000",
      "x-canvas-capability": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ success: true, result }),
  });
}

async function startCapabilityApp(
  options: {
    wallet?: ReturnType<typeof fakeBridge>;
    provider?: ReturnType<typeof fakeProvider>;
    modelProviderKeys?: Record<string, string>;
  } = {},
) {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:3000",
    MODEL_CATALOG_JSON: JSON.stringify([
      {
        id: "custom-image",
        capability: "image",
        provider: "generic",
        baseUrl: "https://provider.example.test",
        priceVersion: "2026-09-07",
        price: 3,
      },
    ]),
    MODEL_PROVIDER_KEYS_JSON: JSON.stringify(options.modelProviderKeys || {}),
  });
  const db = openDatabase(":memory:");
  const sessions = new SessionStore(db);
  const ownerCookie = `canvas_session=${sessions.create({ id: "42", username: "alice", displayName: "Alice", avatarUrl: "" }).token}`;
  const otherCookie = `canvas_session=${sessions.create({ id: "43", username: "bob", displayName: "Bob", avatarUrl: "" }).token}`;
  const wallet = options.wallet || fakeBridge();
  const provider = options.provider || fakeProvider();
  const server = createServer(
    createApp({
      config,
      db,
      sessions,
      bridge: wallet as unknown as BridgeClient,
      provider,
      logger: createLogger("silent"),
    }),
  );
  await listen(server);
  server.once("close", () => db.close());
  return {
    app: { server, url: `http://127.0.0.1:${addressPort(server)}` },
    ownerCookie,
    otherCookie,
    wallet,
    provider,
  };
}

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
  };
  return wallet;
}

function fakeProvider() {
  const provider = {
    proxies: [] as unknown[],
    executions: [] as unknown[],
    validate: async () => undefined,
    execute: async (...input: unknown[]) => {
      provider.executions.push(input);
      return { providerStatus: "unused", output: null };
    },
    proxy: async (
      _entry: unknown,
      request: unknown,
      _apiKeyEnvelope: string,
    ) => {
      provider.proxies.push(request);
      return { accepted: true };
    },
  } satisfies ProviderExecutor & { proxies: unknown[] };
  return provider;
}

function close(running: RunningServer) {
  return new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error ? reject(error) : resolve()));
  });
}
