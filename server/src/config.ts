import { resolve } from "node:path";
import { z } from "zod";
import { loadCatalog } from "./billing/catalog.js";

const booleanValue = z
  .preprocess((value) => value === "true", z.boolean())
  .default(false);

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3001),
  APP_ORIGIN: z.string().url().optional().default("http://localhost:3000"),
  DATABASE_PATH: z.string().optional().default("./data/canvas.sqlite"),
  FLARUM_BASE_URL: optionalUrl,
  FLARUM_INTERNAL_BASE_URL: optionalUrl,
  OAUTH_CLIENT_ID: optionalText,
  OAUTH_CLIENT_SECRET: optionalText,
  OAUTH_REDIRECT_URI: optionalUrl,
  OAUTH_AUTHORIZE_PATH: z.string().optional().default("/oauth/authorize"),
  OAUTH_TOKEN_PATH: z.string().optional().default("/oauth/token"),
  OAUTH_USER_PATH: z.string().optional().default("/api/user"),
  OAUTH_SCOPE: z.string().optional().default("user.read"),
  OAUTH_USE_PKCE: booleanValue,
  OAUTH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(10000),
  AUTH_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .optional()
    .default(60000),
  MODEL_PROVIDER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(600000)
    .optional()
    .default(120000),
  BRIDGE_URL: optionalUrl,
  BRIDGE_TOKEN: optionalText,
  MODEL_CATALOG_JSON: z.string().optional().default("[]"),
  MODEL_PROVIDER_KEYS_JSON: z.string().optional().default("{}"),
  PROVIDER_BASE_URL_ALLOWLIST: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["silent", "info", "debug"]).optional().default("info"),
});

export type ServerConfig = {
  nodeEnv: string;
  port: number;
  appOrigin: URL;
  databasePath: string;
  flarumBaseUrl?: URL;
  flarumInternalBaseUrl?: URL;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri: URL;
  oauthAuthorizeUrl?: URL;
  oauthTokenUrl?: URL;
  oauthUserUrl?: URL;
  oauthScope: string;
  oauthUsePkce: boolean;
  oauthTimeoutMs: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  modelProviderTimeoutMs: number;
  bridgeUrl?: URL;
  bridgeToken?: string;
  modelCatalogJson: string;
  modelProviderKeys: Record<string, string>;
  providerBaseUrlAllowlist: string[];
  logLevel: "silent" | "info" | "debug";
};

function childUrl(base: URL, path: string) {
  return new URL(
    path.replace(/^\//, ""),
    `${base.toString().replace(/\/$/, "")}/`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.parse(env);
  const appOrigin = new URL(parsed.APP_ORIGIN);
  const redirectUri = new URL(
    parsed.OAUTH_REDIRECT_URI || new URL("/auth/callback", appOrigin),
  );
  const flarumBaseUrl = parsed.FLARUM_BASE_URL
    ? new URL(parsed.FLARUM_BASE_URL)
    : undefined;
  const flarumInternalBaseUrl = parsed.FLARUM_INTERNAL_BASE_URL
    ? new URL(parsed.FLARUM_INTERNAL_BASE_URL)
    : flarumBaseUrl;
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    appOrigin,
    databasePath: resolve(parsed.DATABASE_PATH),
    flarumBaseUrl,
    flarumInternalBaseUrl,
    oauthClientId: parsed.OAUTH_CLIENT_ID,
    oauthClientSecret: parsed.OAUTH_CLIENT_SECRET,
    oauthRedirectUri: redirectUri,
    oauthAuthorizeUrl: flarumBaseUrl
      ? childUrl(flarumBaseUrl, parsed.OAUTH_AUTHORIZE_PATH)
      : undefined,
    oauthTokenUrl: flarumInternalBaseUrl
      ? childUrl(flarumInternalBaseUrl, parsed.OAUTH_TOKEN_PATH)
      : undefined,
    oauthUserUrl: flarumInternalBaseUrl
      ? childUrl(flarumInternalBaseUrl, parsed.OAUTH_USER_PATH)
      : undefined,
    oauthScope: parsed.OAUTH_SCOPE,
    oauthUsePkce: parsed.OAUTH_USE_PKCE,
    oauthTimeoutMs: parsed.OAUTH_TIMEOUT_MS,
    authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
    authRateLimitWindowMs: parsed.AUTH_RATE_LIMIT_WINDOW_MS,
    modelProviderTimeoutMs: parsed.MODEL_PROVIDER_TIMEOUT_MS,
    bridgeUrl: parsed.BRIDGE_URL ? new URL(parsed.BRIDGE_URL) : undefined,
    bridgeToken: parsed.BRIDGE_TOKEN,
    modelCatalogJson: parsed.MODEL_CATALOG_JSON,
    modelProviderKeys: parseProviderKeys(parsed.MODEL_PROVIDER_KEYS_JSON),
    providerBaseUrlAllowlist: parsed.PROVIDER_BASE_URL_ALLOWLIST.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    logLevel: parsed.LOG_LEVEL,
  };
}

function parseProviderKeys(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_PROVIDER_KEYS_JSON must be valid JSON");
  }
  return z.record(z.string().trim().min(1)).parse(value);
}

function assertOAuthConfig(config: ServerConfig) {
  if (
    !config.oauthAuthorizeUrl ||
    !config.oauthTokenUrl ||
    !config.oauthUserUrl ||
    !config.oauthClientId ||
    !config.oauthClientSecret
  ) {
    throw new Error("OAuth server configuration is incomplete");
  }
}

export function assertProductionConfig(config: ServerConfig) {
  if (config.nodeEnv !== "production") return;
  if (config.appOrigin.protocol !== "https:")
    throw new Error("APP_ORIGIN must use HTTPS in production");
  for (const [name, url] of [
    ["FLARUM_BASE_URL", config.flarumBaseUrl],
    ["BRIDGE_URL", config.bridgeUrl],
  ] as const) {
    if (url && url.protocol !== "https:")
      throw new Error(`${name} must use HTTPS in production`);
  }
  assertOAuthConfig(config);
  if (!config.flarumBaseUrl)
    throw new Error("FLARUM_BASE_URL is required in production");
  if (!config.bridgeUrl || !config.bridgeToken)
    throw new Error("BRIDGE_URL and BRIDGE_TOKEN are required in production");
  if (!config.providerBaseUrlAllowlist.length)
    throw new Error("PROVIDER_BASE_URL_ALLOWLIST is required in production");
  const expectedRedirect = new URL("/auth/callback", config.appOrigin);
  if (config.oauthRedirectUri.toString() !== expectedRedirect.toString())
    throw new Error(
      "OAUTH_REDIRECT_URI must exactly match the Canvas callback in production",
    );
  const catalog = loadCatalog(config.modelCatalogJson);
  if (!catalog.some((entry) => Boolean(config.modelProviderKeys[entry.id])))
    throw new Error(
      "MODEL_CATALOG_JSON and MODEL_PROVIDER_KEYS_JSON must configure at least one managed model in production",
    );
}
