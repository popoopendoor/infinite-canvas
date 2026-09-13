import assert from "node:assert/strict";
import { publicEncrypt } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../config.js";
import { encryptionPublicKey } from "../crypto.js";
import { HttpError } from "../errors.js";
import { HttpProviderExecutor, ProviderUnknownError } from "./executor.js";

test("binary provider responses preserve bytes", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  const bytes = Uint8Array.from([0, 255, 1, 128, 10]);
  let redirect = "";
  const fetcher: typeof fetch = async (_input, init) => {
    redirect = String(init?.redirect);
    return new Response(bytes, { headers: { "content-type": "audio/mpeg" } });
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);
  const result = await executor.execute(
    {
      id: "audio-basic",
      capability: "audio",
      provider: "generic",
      baseUrl: "https://8.8.8.8",
      model: "audio-basic",
      priceVersion: "2026-09-06",
      price: 1,
    },
    {
      modelId: "audio-basic",
      capability: "audio",
      prompt: "hello",
      params: {},
      references: [],
      idempotencyKey: "request-001",
      apiKeyEnvelope: secret,
    },
  );

  assert.deepEqual(
    Buffer.from((result.output as { base64: string }).base64, "base64"),
    Buffer.from(bytes),
  );
  assert.equal(redirect, "error");
});

test("managed models use the server provider key without a browser envelope", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
    MODEL_PROVIDER_KEYS_JSON: JSON.stringify({
      "managed-text": "provider-secret",
    }),
  });
  let authorization = "";
  const executor = new HttpProviderExecutor(
    config,
    10_000,
    async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json({
        choices: [{ message: { content: "managed result" } }],
      });
    },
  );

  const result = await executor.execute(
    {
      id: "managed-text",
      capability: "text",
      provider: "openai",
      baseUrl: "https://8.8.8.8",
      model: "published-text-model",
      priceVersion: "v1",
      price: 1,
    },
    {
      modelId: "managed-text",
      capability: "text",
      prompt: "hello",
      params: {},
      references: [],
      idempotencyKey: "managed-request-001",
    },
  );

  assert.equal(authorization, "Bearer provider-secret");
  assert.deepEqual(result.output, { kind: "text", text: "managed result" });
});

test("image provider URLs are downloaded before billing completes", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  const requests: string[] = [];
  let mediaHeaders: Headers | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(String(input));
    if (requests.length === 1)
      return Response.json({
        data: [{ url: "https://8.8.8.8/generated.png" }],
      });
    mediaHeaders = new Headers(init?.headers);
    return new Response(Buffer.from("png-bytes"), {
      headers: { "content-type": "image/png" },
    });
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);
  const result = await executor.execute(
    {
      id: "catalog-image",
      capability: "image",
      provider: "openai",
      baseUrl: "https://8.8.8.8",
      model: "published-image-model",
      priceVersion: "v1",
      price: 1,
    },
    {
      modelId: "catalog-image",
      capability: "image",
      prompt: "hello",
      params: {},
      references: [],
      idempotencyKey: "image-url-001",
      apiKeyEnvelope: secret,
    },
  );

  assert.deepEqual(requests, [
    "https://8.8.8.8/v1/images/generations",
    "https://8.8.8.8/generated.png",
  ]);
  assert.deepEqual(result.output, {
    kind: "images",
    items: [{ dataUrl: "data:image/png;base64,cG5nLWJ5dGVz" }],
  });
  assert.equal(mediaHeaders?.get("authorization"), "Bearer provider-secret");
  assert.equal(mediaHeaders?.get("x-goog-api-key"), null);
});

test("image provider HTTP result URLs are upgraded on the configured HTTPS origin", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requests.push(String(input));
    return requests.length === 1
      ? Response.json({ data: [{ url: "http://8.8.8.8/generated.png" }] })
      : new Response(Buffer.from("png-bytes"), {
          headers: { "content-type": "image/png" },
        });
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);

  await executor.execute(
    {
      id: "catalog-image",
      capability: "image",
      provider: "openai",
      baseUrl: "https://8.8.8.8",
      model: "published-image-model",
      priceVersion: "v1",
      price: 1,
    },
    {
      modelId: "catalog-image",
      capability: "image",
      prompt: "hello",
      params: {},
      references: [],
      idempotencyKey: "image-http-url-001",
      apiKeyEnvelope: secret,
    },
  );

  assert.deepEqual(requests, [
    "https://8.8.8.8/v1/images/generations",
    "https://8.8.8.8/generated.png",
  ]);
});

test("image provider URLs cannot leave the configured provider origin", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  let requests = 0;
  const executor = new HttpProviderExecutor(config, 10_000, async () => {
    requests += 1;
    return Response.json({
      data: [{ url: "https://attacker.example/generated.png" }],
    });
  });

  await assert.rejects(
    executor.execute(
      {
        id: "catalog-image",
        capability: "image",
        provider: "openai",
        baseUrl: "https://8.8.8.8",
        model: "published-image-model",
        priceVersion: "v1",
        price: 1,
      },
      {
        modelId: "catalog-image",
        capability: "image",
        prompt: "hello",
        params: {},
        references: [],
        idempotencyKey: "image-url-002",
        apiKeyEnvelope: secret,
      },
    ),
    (error: unknown) => error instanceof ProviderUnknownError,
  );
  assert.equal(requests, 1);
});

test("image references use the provider edit endpoint and multipart body", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  let target = "";
  let contentType = "";
  let formValues: Record<string, string> = {};
  const fetcher: typeof fetch = async (input, init) => {
    target = String(input);
    contentType = String(
      (init?.headers as Record<string, string>)?.["content-type"] || "",
    );
    const form = await new Response(init?.body).formData();
    form.forEach((value, key) => {
      if (typeof value === "string") formValues[key] = value;
    });
    return Response.json({ data: [{ b64_json: "aGVsbG8=" }] });
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);
  const result = await executor.execute(
    {
      id: "image-basic",
      capability: "image",
      provider: "openai",
      baseUrl: "https://8.8.8.8",
      model: "image-basic",
      priceVersion: "2026-09-07",
      price: 1,
    },
    {
      modelId: "image-basic",
      capability: "image",
      prompt: "edit this",
      params: {
        count: 2,
        size: "1024x1024",
        quality: "high",
        background: "transparent",
        outputFormat: "png",
      },
      references: [
        {
          dataUrl: "data:image/png;base64,aGVsbG8=",
          mimeType: "image/png",
        },
      ],
      idempotencyKey: "request-002",
      apiKeyEnvelope: secret,
    },
  );

  assert.match(target, /\/v1\/images\/edits$/);
  assert.equal(contentType, "");
  assert.deepEqual(formValues, {
    model: "image-basic",
    prompt: "edit this",
    n: "2",
    size: "1024x1024",
    quality: "high",
    background: "transparent",
    output_format: "png",
    response_format: "b64_json",
  });
  assert.deepEqual(result.output, {
    kind: "images",
    items: [{ dataUrl: "data:image/png;base64,aGVsbG8=" }],
  });
});

test("video is captured only after the provider reports completion", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  const requests: Array<{ url: string; redirect: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, redirect: String(init?.redirect) });
    if (url.endsWith("/v1/videos"))
      return Response.json({
        id: "video-1",
        status: "completed",
        url: "/media/video-1",
      });
    if (url.endsWith("/media/video-1"))
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "video/mp4" },
      });
    throw new Error(`unexpected URL: ${url}`);
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);

  const result = await executor.execute(
    {
      id: "video-basic",
      capability: "video",
      provider: "openai",
      baseUrl: "https://8.8.8.8",
      model: "video-basic",
      priceVersion: "2026-09-07",
      price: 3,
    },
    {
      modelId: "video-basic",
      capability: "video",
      prompt: "a small scene",
      params: {},
      references: [],
      idempotencyKey: "request-003",
      apiKeyEnvelope: secret,
    },
  );

  assert.deepEqual(requests, [
    { url: "https://8.8.8.8/v1/videos", redirect: "error" },
    { url: "https://8.8.8.8/media/video-1", redirect: "error" },
  ]);
  assert.deepEqual(result.output, {
    kind: "binary",
    contentType: "video/mp4",
    base64: Buffer.from([1, 2, 3]).toString("base64"),
  });
});

test("capability proxy uses the catalog origin and replaces browser credentials", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  let target = "";
  let authorization = "";
  let redirect = "";
  let body: unknown;
  const fetcher: typeof fetch = async (input, init) => {
    target = String(input);
    authorization = new Headers(init?.headers).get("authorization") || "";
    redirect = String(init?.redirect);
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);
  const entry = {
    id: "custom-text",
    capability: "text" as const,
    provider: "openai" as const,
    baseUrl: "https://8.8.8.8/v1",
    model: "published-text-model",
    priceVersion: "v1",
    price: 1,
  };

  const result = await executor.proxy(
    entry,
    {
      method: "POST",
      url: "/v1/chat/completions?key=capability&api_key=capability&apiKey=capability&access_token=capability&token=capability&model=browser-model&safe=url",
      headers: { authorization: "Bearer attacker", "x-client": "canvas" },
      params: {
        stream: false,
        key: "capability",
        api_key: "capability",
        apiKey: "capability",
        access_token: "capability",
        token: "capability",
        model: "browser-model",
      },
      data: { model: "browser-model", prompt: "hello" },
    },
    secret,
  );

  assert.equal(
    target,
    "https://8.8.8.8/v1/chat/completions?model=published-text-model&safe=url&stream=false",
  );
  assert.equal(authorization, "Bearer provider-secret");
  assert.equal(redirect, "error");
  assert.deepEqual(body, { model: "published-text-model", prompt: "hello" });
  assert.deepEqual(result, { ok: true });
  await assert.rejects(
    executor.proxy(
      entry,
      {
        method: "GET",
        url: "https://attacker.example/steal",
        headers: {},
      },
      secret,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Provider request URL is not allowed",
  );
});

test("capability proxy locks catalog models in multipart and Gemini requests", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PROVIDER_BASE_URL_ALLOWLIST: "8.8.8.8",
  });
  const secret = publicEncrypt(
    { key: encryptionPublicKey(), oaepHash: "sha256" },
    Buffer.from("provider-secret"),
  ).toString("base64url");
  const requests: Array<{ target: string; model: string; apiKey: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const contentType = new Headers(init?.headers).get("content-type") || "";
    const form = contentType ? null : await new Response(init?.body).formData();
    requests.push({
      target: String(input),
      model: form?.get("model")?.toString() || "",
      apiKey: new Headers(init?.headers).get("x-goog-api-key") || "",
    });
    return Response.json({ ok: true });
  };
  const executor = new HttpProviderExecutor(config, 10_000, fetcher);

  await executor.proxy(
    {
      id: "catalog-image",
      capability: "image",
      provider: "openai",
      baseUrl: "https://8.8.8.8",
      model: "published-image-model",
      priceVersion: "v1",
      price: 1,
    },
    {
      method: "POST",
      url: "/v1/images/edits",
      headers: {},
      data: {
        kind: "form",
        fields: [
          { name: "model", value: "browser-model" },
          { name: "prompt", value: "hello" },
        ],
      },
    },
    secret,
  );
  await executor.proxy(
    {
      id: "catalog-gemini",
      capability: "text",
      provider: "gemini",
      baseUrl: "https://8.8.8.8",
      model: "published-gemini-model",
      priceVersion: "v1",
      price: 1,
    },
    {
      method: "POST",
      url: "/v1beta/models/browser-model:generateContent",
      headers: {},
      data: {},
    },
    secret,
  );

  assert.deepEqual(requests, [
    {
      target: "https://8.8.8.8/v1/images/edits",
      model: "published-image-model",
      apiKey: "",
    },
    {
      target:
        "https://8.8.8.8/v1beta/models/published-gemini-model:generateContent",
      model: "",
      apiKey: "provider-secret",
    },
  ]);
});
