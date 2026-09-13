import assert from "node:assert/strict";
import test from "node:test";

import { assertProductionConfig, loadConfig } from "./config.js";

test("production requires HTTPS for the public origin", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "http://canvas.example.test",
    FLARUM_BASE_URL: "https://forum.example.test",
    BRIDGE_URL: "https://forum.example.test/api",
  });
  assert.throws(
    () => assertProductionConfig(config),
    /APP_ORIGIN must use HTTPS in production/,
  );
});

test("production requires HTTPS for Flarum and bridge URLs", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "https://canvas.example.test",
    FLARUM_BASE_URL: "http://forum.example.test",
    BRIDGE_URL: "https://forum.example.test/api",
  });
  assert.throws(
    () => assertProductionConfig(config),
    /FLARUM_BASE_URL must use HTTPS in production/,
  );
});

test("development allows HTTP local origins", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    APP_ORIGIN: "http://localhost:3000",
  });
  assert.doesNotThrow(() => assertProductionConfig(config));
});

test("uses the internal Flarum URL for server-side OAuth requests", () => {
  const config = loadConfig({
    APP_ORIGIN: "http://localhost:3000",
    FLARUM_BASE_URL: "http://127.0.0.1",
    FLARUM_INTERNAL_BASE_URL: "http://host.docker.internal",
  });
  assert.equal(
    config.oauthAuthorizeUrl?.toString(),
    "http://127.0.0.1/oauth/authorize",
  );
  assert.equal(
    config.oauthTokenUrl?.toString(),
    "http://host.docker.internal/oauth/token",
  );
  assert.equal(
    config.oauthUserUrl?.toString(),
    "http://host.docker.internal/api/user",
  );
});

test("loads server-only provider keys without exposing their values", () => {
  const config = loadConfig({
    MODEL_PROVIDER_KEYS_JSON: JSON.stringify({
      "managed-text": "provider-key",
    }),
  });
  assert.deepEqual(Object.keys(config.modelProviderKeys), ["managed-text"]);
  assert.equal(config.modelProviderKeys["managed-text"], "provider-key");
});

test("rejects an invalid server provider key map", () => {
  assert.throws(
    () => loadConfig({ MODEL_PROVIDER_KEYS_JSON: "[]" }),
    /MODEL_PROVIDER_KEYS_JSON must be valid JSON|Expected object, received array/,
  );
});

test("production requires complete OAuth, bridge, and provider configuration", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "https://canvas.example.test",
    FLARUM_BASE_URL: "https://forum.example.test",
    BRIDGE_URL: "https://forum.example.test/api",
    BRIDGE_TOKEN: "bridge-secret",
    PROVIDER_BASE_URL_ALLOWLIST: "api.example.test",
  });
  assert.throws(
    () => assertProductionConfig(config),
    /OAuth server configuration is incomplete/,
  );
});

test("production requires the exact Canvas callback URL", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "https://canvas.example.test",
    FLARUM_BASE_URL: "https://forum.example.test",
    OAUTH_CLIENT_ID: "canvas",
    OAUTH_CLIENT_SECRET: "secret",
    OAUTH_REDIRECT_URI: "https://other.example.test/auth/callback",
    BRIDGE_URL: "https://forum.example.test/api",
    BRIDGE_TOKEN: "bridge-secret",
    PROVIDER_BASE_URL_ALLOWLIST: "api.example.test",
  });
  assert.throws(
    () => assertProductionConfig(config),
    /OAUTH_REDIRECT_URI must exactly match/,
  );
});

test("production accepts a complete secure configuration", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "https://canvas.example.test",
    FLARUM_BASE_URL: "https://forum.example.test",
    OAUTH_CLIENT_ID: "canvas",
    OAUTH_CLIENT_SECRET: "secret",
    OAUTH_REDIRECT_URI: "https://canvas.example.test/auth/callback",
    BRIDGE_URL: "https://forum.example.test/api",
    BRIDGE_TOKEN: "bridge-secret",
    MODEL_CATALOG_JSON: JSON.stringify([
      {
        id: "managed-text",
        capability: "text",
        provider: "openai",
        baseUrl: "https://api.example.test",
        priceVersion: "v1",
        price: 1,
      },
    ]),
    MODEL_PROVIDER_KEYS_JSON: JSON.stringify({
      "managed-text": "provider-key",
    }),
    PROVIDER_BASE_URL_ALLOWLIST: "api.example.test",
  });
  assert.doesNotThrow(() => assertProductionConfig(config));
});

test("production requires at least one published managed model", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "https://canvas.example.test",
    FLARUM_BASE_URL: "https://forum.example.test",
    OAUTH_CLIENT_ID: "canvas",
    OAUTH_CLIENT_SECRET: "secret",
    OAUTH_REDIRECT_URI: "https://canvas.example.test/auth/callback",
    BRIDGE_URL: "https://forum.example.test/api",
    BRIDGE_TOKEN: "bridge-secret",
    MODEL_CATALOG_JSON: JSON.stringify([
      {
        id: "byok-text",
        capability: "text",
        provider: "openai",
        baseUrl: "https://api.example.test",
        priceVersion: "v1",
        price: 1,
      },
    ]),
    PROVIDER_BASE_URL_ALLOWLIST: "api.example.test",
  });
  assert.throws(
    () => assertProductionConfig(config),
    /must configure at least one managed model/,
  );
});
