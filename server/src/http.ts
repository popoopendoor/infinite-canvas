import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import type { Database } from "./db.js";
import { asHttpError, HttpError } from "./errors.js";
import { createLogger } from "./logger.js";
import {
  OAuthClient,
  OAuthTransactionError,
  OAuthUpstreamError,
} from "./auth/oauth.js";
import { SessionStore, type SessionRecord } from "./auth/session.js";
import {
  clearCookie,
  OAUTH_TRANSACTION_COOKIE,
  readCookie,
  SESSION_COOKIE,
  setCookie,
} from "./auth/cookies.js";
import { safeReturnTo } from "./auth/return-to.js";
import { encryptionPublicKey } from "./crypto.js";
import { CatalogStore } from "./billing/catalog-store.js";
import { BridgeClient } from "./billing/bridge-client.js";
import { BillingTaskService } from "./billing/tasks.js";
import { CustomCapabilityService } from "./billing/custom-capability.js";
import {
  HttpProviderExecutor,
  ProviderUnknownError,
  type ProviderExecutor,
} from "./provider/executor.js";
import {
  normalizeCustomRequest,
  normalizeQuote,
  normalizeRequest,
  providerModel,
  type Capability,
} from "./billing/catalog.js";

export type AppDependencies = {
  config: ServerConfig;
  db: Database;
  oauth?: OAuthClient;
  sessions?: SessionStore;
  logger?: ReturnType<typeof createLogger>;
  bridge?: BridgeClient;
  provider?: ProviderExecutor;
  billing?: BillingTaskService;
  customCapabilities?: CustomCapabilityService;
};

const AUTH_ERROR_REASONS = new Set([
  "oauth_denied",
  "invalid_callback",
  "oauth_unavailable",
  "rate_limited",
]);
const MAX_AUTH_RATE_KEYS = 10_000;

export function createApp(dependencies: AppDependencies) {
  const { config, db } = dependencies;
  const oauth = dependencies.oauth || new OAuthClient(db, config);
  const sessions = dependencies.sessions || new SessionStore(db);
  const logger = dependencies.logger || createLogger(config.logLevel);
  const catalog = new CatalogStore(db, config.modelCatalogJson);
  const bridge = dependencies.bridge || new BridgeClient(config);
  const provider =
    dependencies.provider ||
    new HttpProviderExecutor(config, config.modelProviderTimeoutMs);
  const billing =
    dependencies.billing || new BillingTaskService(db, bridge, provider);
  const customCapabilities =
    dependencies.customCapabilities ||
    new CustomCapabilityService(db, bridge, provider);
  const app = express();
  const limitAuth = authRateLimiter(
    config.authRateLimitMax,
    config.authRateLimitWindowMs,
  );

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "20mb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const startedAt = Date.now();
    res.on("finish", () =>
      logger.debug("http_request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
    next();
  });

  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "canvas-bff" }),
  );
  app.get("/auth/public-key", (_req, res) =>
    res.type("text/plain").send(encryptionPublicKey()),
  );

  app.get("/auth/login", limitAuth, async (req, res) => {
    const returnTo = safeReturnTo(
      typeof req.query.returnTo === "string" ? req.query.returnTo : undefined,
      config,
    );
    try {
      const transaction = oauth.begin(returnTo);
      setCookie(res, OAUTH_TRANSACTION_COOKIE, transaction.transactionToken, {
        maxAge: 600,
        secure: cookieSecure(config),
      });
      res.redirect(302, oauth.authorizationUrl(transaction).toString());
    } catch (error) {
      if (error instanceof OAuthUpstreamError)
        return void redirectAuthError(res, "oauth_unavailable");
      throw error;
    }
  });

  app.post(
    "/api/model-capabilities",
    requireSession(sessions),
    async (req, res) => {
      verifyOrigin(req, config);
      const user = authenticatedUser(req);
      const request = normalizeCustomRequest(req.body);
      const entry = catalog.find(request.modelId, request.capability);
      const grant = await customCapabilities.start(
        user,
        request,
        entry,
        request.scriptHash,
      );
      res.json({
        ok: true,
        capability: grant.token
          ? { token: grant.token, expiresAt: grant.expiresAt }
          : null,
        target: grant.token
          ? { baseUrl: entry.baseUrl, model: providerModel(entry) }
          : null,
        task: publicTask(grant.task),
      });
    },
  );

  app.post(
    "/api/model-capabilities/request",
    requireSession(sessions),
    async (req, res) => {
      verifyOrigin(req, config);
      const user = authenticatedUser(req);
      const token = capabilityToken(req);
      const active = customCapabilities.active(user.id, token);
      const entry = catalog.find(
        active.modelId,
        active.capability as Capability,
      );
      const request = normalizeCapabilityProxyRequest(req.body);
      if (!provider.proxy)
        throw new HttpError(
          503,
          "service_unavailable",
          "Capability proxy is unavailable",
        );
      try {
        const data = await provider.proxy(
          entry,
          request,
          request.apiKeyEnvelope,
        );
        res.json({ ok: true, data });
      } catch (error) {
        if (error instanceof ProviderUnknownError) {
          customCapabilities.abandon(user.id, token);
          throw new HttpError(
            503,
            "provider_unknown",
            "Provider result requires reconciliation",
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/model-capabilities/complete",
    requireSession(sessions),
    async (req, res) => {
      verifyOrigin(req, config);
      const user = authenticatedUser(req);
      const token = capabilityToken(req);
      const body = capabilityCompletionSchema.parse(req.body);
      const task = await customCapabilities.complete(
        user.id,
        token,
        body.result,
        body.success ? undefined : body.error,
      );
      res.json({ ok: true, task: publicTask(task) });
    },
  );

  app.post(
    "/api/model-capabilities/abandon",
    requireSession(sessions),
    async (req, res) => {
      verifyOrigin(req, config);
      const user = authenticatedUser(req);
      const token = capabilityToken(req);
      const task = customCapabilities.abandon(user.id, token);
      if (!task) throw new HttpError(404, "not_found", "Capability not found");
      res.json({ ok: true, task: publicTask(task) });
    },
  );

  app.get("/auth/callback", limitAuth, async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const providerError =
      typeof req.query.error === "string" ? req.query.error : "";
    const transactionToken = readCookie(req, OAUTH_TRANSACTION_COOKIE);
    clearCookie(res, OAUTH_TRANSACTION_COOKIE, cookieSecure(config));
    if (providerError) {
      if (state && transactionToken) {
        try {
          oauth.consume(state, transactionToken);
        } catch {
          // The denial response is already terminal; do not expose transaction state.
        }
      }
      return void redirectAuthError(res, "oauth_denied");
    }
    if (!code || !state || !transactionToken)
      return void redirectAuthError(res, "invalid_callback");
    try {
      const result = await oauth.finish(state, transactionToken, code);
      const existingSession = readCookie(req, SESSION_COOKIE);
      if (existingSession) sessions.revoke(existingSession);
      const session = sessions.create(result.user);
      setCookie(res, SESSION_COOKIE, session.token, {
        maxAge: 30 * 24 * 60 * 60,
        secure: cookieSecure(config),
      });
      res.redirect(303, result.returnTo);
    } catch (error) {
      logger.error("oauth_callback_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      redirectAuthError(
        res,
        error instanceof OAuthTransactionError
          ? "invalid_callback"
          : error instanceof OAuthUpstreamError
            ? "oauth_unavailable"
            : "invalid_callback",
      );
    }
  });

  app.get("/auth/session", async (req, res) => {
    const session = getSession(req, sessions);
    if (!session) return void res.json({ authenticated: false });
    res.json({ authenticated: true, user: session.user });
  });

  app.post("/auth/logout", async (req, res) => {
    verifyOrigin(req, config);
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.revoke(token);
    clearCookie(res, SESSION_COOKIE, cookieSecure(config));
    res.json({ ok: true });
  });

  app.get("/api/models", requireSession(sessions), async (_req, res) => {
    res.json({
      ok: true,
      catalogRelease: {
        id: catalog.release.id,
        contentHash: catalog.release.contentHash,
        activatedAt: catalog.release.activatedAt,
      },
      models: catalog
        .list()
        .map(
          ({
            id,
            capability,
            provider,
            baseUrl,
            model,
            priceVersion,
            price,
          }) => ({
            id,
            capability,
            provider,
            baseUrl,
            apiFormat: provider === "gemini" ? "gemini" : "openai",
            ...(model ? { model } : {}),
            priceVersion,
            price,
            credentialMode: config.modelProviderKeys[id] ? "managed" : "byok",
          }),
        ),
    });
  });

  app.get("/api/wallet", requireSession(sessions), async (req, res) => {
    const user = authenticatedUser(req);
    res.json({ ok: true, balance: await bridge.balance(user.id) });
  });

  app.post("/api/quote", requireSession(sessions), async (req, res) => {
    verifyOrigin(req, config);
    const quote = normalizeQuote(req.body);
    const entry = catalog.find(quote.modelId, quote.capability);
    res.json({
      ok: true,
      modelId: entry.id,
      capability: entry.capability,
      price: entry.price,
      priceVersion: entry.priceVersion,
    });
  });

  app.post("/api/model-tasks", requireSession(sessions), async (req, res) => {
    verifyOrigin(req, config);
    const user = authenticatedUser(req);
    const request = normalizeRequest(req.body);
    const entry = catalog.find(request.modelId, request.capability);
    const task = await billing.execute(user, request, entry);
    res.json({ ok: true, task: publicTask(task) });
  });

  app.post(
    "/api/model-task-batches",
    requireSession(sessions),
    async (req, res) => {
      verifyOrigin(req, config);
      const user = authenticatedUser(req);
      const body = batchRequestSchema.parse(req.body);
      const inputs = body.requests.map((value) => {
        const request = normalizeRequest(value);
        return {
          request,
          entry: catalog.find(request.modelId, request.capability),
        };
      });
      const batch = await billing.executeBatch(user, inputs);
      res.json({
        ok: true,
        status: batch.status,
        tasks: batch.tasks.map(publicTask),
      });
    },
  );

  app.get(
    "/api/model-tasks/:id",
    requireSession(sessions),
    async (req, res) => {
      const user = authenticatedUser(req);
      const taskId = typeof req.params.id === "string" ? req.params.id : "";
      const task = billing.get(user.id, taskId);
      res.json({ ok: true, task: publicTask(task) });
    },
  );

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const normalized = asHttpError(error);
      if (normalized.status >= 500)
        logger.error("http_request_failed", {
          code: normalized.code,
          error: normalized.message,
        });
      res.status(normalized.status).json({
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details ? { details: normalized.details } : {}),
        },
      });
    },
  );
  return app;
}

function requireSession(sessions: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const session = getSession(req, sessions);
      if (!session)
        throw new HttpError(401, "unauthenticated", "Authentication required");
      req.session = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function getSession(req: Request, sessions: SessionStore) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    return sessions.getValid(token);
  } catch {
    throw new HttpError(
      503,
      "service_unavailable",
      "Authentication service is unavailable",
    );
  }
}

function authenticatedUser(req: Request) {
  const user = req.session?.user;
  if (!user)
    throw new HttpError(401, "unauthenticated", "Authentication required");
  return user;
}

function verifyOrigin(req: Request, config: ServerConfig) {
  const origin = req.header("origin");
  if (!origin || origin !== config.appOrigin.origin)
    throw new HttpError(403, "forbidden", "Request origin is not allowed");
}

function capabilityToken(req: Request) {
  const token = req.header("x-canvas-capability")?.trim();
  if (!token)
    throw new HttpError(401, "unauthenticated", "Capability is invalid");
  return token;
}

function redirectAuthError(res: Response, reason: string) {
  const value = AUTH_ERROR_REASONS.has(reason) ? reason : "invalid_callback";
  res.redirect(303, `/login/error?reason=${encodeURIComponent(value)}`);
}

function authRateLimiter(limit: number, windowMs: number) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (attempts.size > MAX_AUTH_RATE_KEYS)
      for (const [key, value] of attempts)
        if (value.resetAt <= now) attempts.delete(key);
    const key = req.ip || "unknown";
    const current = attempts.get(key);
    const value =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    if (value.count >= limit) {
      res.setHeader(
        "Retry-After",
        Math.max(1, Math.ceil((value.resetAt - now) / 1000)),
      );
      return void redirectAuthError(res, "rate_limited");
    }
    value.count += 1;
    attempts.set(key, value);
    next();
  };
}

function cookieSecure(config: ServerConfig) {
  return config.appOrigin.protocol === "https:";
}

function publicTask(task: ReturnType<BillingTaskService["get"]>) {
  return {
    id: task.id,
    modelId: task.modelId,
    capability: task.capability,
    priceVersion: task.priceVersion,
    amount: task.amount,
    status: task.status,
    providerStatus: task.providerStatus,
    result: task.resultJson ? JSON.parse(task.resultJson) : undefined,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

const capabilityCompletionSchema = z
  .object({
    success: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().trim().min(1).max(4_000).optional(),
  })
  .superRefine((value, context) => {
    if (!value.success && !value.error)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error is required when success is false",
      });
    if (value.success && value.result === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result is required when success is true",
      });
  });

const batchRequestSchema = z.object({
  requests: z.array(z.unknown()).min(1).max(20),
});

function normalizeCapabilityProxyRequest(input: unknown) {
  const value = z
    .object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      url: z.string().trim().min(1).max(4_000),
      headers: z.record(z.string().max(4_000)).default({}),
      params: z.record(z.unknown()).optional(),
      data: z.unknown().optional(),
      responseType: z.enum(["json", "blob", "text", "arraybuffer"]).optional(),
      apiKeyEnvelope: z.string().max(20_000).optional(),
    })
    .parse(input);
  return value;
}

declare global {
  namespace Express {
    interface Request {
      session?: SessionRecord;
    }
  }
}
