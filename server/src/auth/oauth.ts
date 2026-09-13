import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import { hashToken, randomToken } from "../crypto.js";
import type { ServerConfig } from "../config.js";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
};

type OAuthPayload = Record<string, unknown>;

export type OAuthTransaction = {
  state: string;
  transactionToken: string;
  codeVerifier?: string;
};

export class OAuthUpstreamError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "OAuthUpstreamError";
  }
}

export class OAuthTransactionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "OAuthTransactionError";
  }
}

export class OAuthClient {
  constructor(
    private readonly db: Database,
    private readonly config: ServerConfig,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  begin(returnTo: string): OAuthTransaction {
    if (!this.config.oauthAuthorizeUrl || !this.config.oauthClientId)
      throw new OAuthUpstreamError("OAuth is not configured");
    const state = randomToken();
    const transactionToken = randomToken();
    const codeVerifier = this.config.oauthUsePkce ? randomToken(48) : undefined;
    const expiresAt = this.now() + 600;
    this.db
      .prepare(
        "INSERT INTO oauth_states (state_hash, transaction_hash, return_to, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        hashToken(state),
        hashToken(transactionToken),
        returnTo,
        codeVerifier || null,
        expiresAt,
      );
    return {
      state,
      transactionToken,
      ...(codeVerifier ? { codeVerifier } : {}),
    };
  }

  authorizationUrl(transaction: OAuthTransaction) {
    if (!this.config.oauthAuthorizeUrl || !this.config.oauthClientId)
      throw new OAuthUpstreamError("OAuth is not configured");
    const url = new URL(this.config.oauthAuthorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.oauthClientId);
    url.searchParams.set(
      "redirect_uri",
      this.config.oauthRedirectUri.toString(),
    );
    url.searchParams.set("scope", this.config.oauthScope);
    url.searchParams.set("state", transaction.state);
    if (transaction.codeVerifier) {
      url.searchParams.set(
        "code_challenge",
        createHash("sha256")
          .update(transaction.codeVerifier)
          .digest("base64url"),
      );
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url;
  }

  consume(state: string, transactionToken: string) {
    const result = this.db
      .prepare(
        "UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND transaction_hash = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .run(
        this.now(),
        hashToken(state),
        hashToken(transactionToken),
        this.now(),
      );
    if (result.changes !== 1)
      throw new OAuthTransactionError(
        "OAuth transaction is invalid, expired, or already used",
      );
    return this.db
      .prepare(
        "SELECT return_to, code_verifier FROM oauth_states WHERE state_hash = ?",
      )
      .get(hashToken(state)) as {
      return_to: string;
      code_verifier: string | null;
    };
  }

  async finish(
    state: string,
    transactionToken: string,
    code: string,
  ): Promise<{ user: AuthUser; returnTo: string }> {
    const transaction = this.consume(state, transactionToken);
    const accessToken = await this.exchangeCode(
      code,
      transaction.code_verifier || undefined,
    );
    const user = await this.fetchUser(accessToken);
    return { user, returnTo: transaction.return_to };
  }

  private async exchangeCode(code: string, codeVerifier?: string) {
    if (
      !this.config.oauthTokenUrl ||
      !this.config.oauthClientId ||
      !this.config.oauthClientSecret
    )
      throw new OAuthUpstreamError("OAuth is not configured");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.config.oauthClientId,
      client_secret: this.config.oauthClientSecret,
      redirect_uri: this.config.oauthRedirectUri.toString(),
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);
    const payload = await postOAuth(
      this.config.oauthTokenUrl,
      body,
      this.config.oauthTimeoutMs,
    );
    if (typeof payload.access_token !== "string" || !payload.access_token)
      throw new OAuthUpstreamError("OAuth token response is invalid");
    return payload.access_token;
  }

  private async fetchUser(accessToken: string) {
    if (!this.config.oauthUserUrl)
      throw new OAuthUpstreamError("OAuth is not configured");
    const payload = await getOAuth(
      this.config.oauthUserUrl,
      accessToken,
      this.config.oauthTimeoutMs,
    );
    return normalizeUser(payload);
  }
}

async function postOAuth(url: URL, body: URLSearchParams, timeoutMs: number) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
    timeoutMs,
  );
  return parseOAuthResponse(response);
}

async function getOAuth(url: URL, token: string, timeoutMs: number) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    },
    timeoutMs,
  );
  return parseOAuthResponse(response);
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch {
    throw new OAuthUpstreamError("OAuth upstream request failed or timed out");
  }
}

async function parseOAuthResponse(response: Response): Promise<OAuthPayload> {
  const text = await response.text();
  if (text.length > 1_000_000)
    throw new OAuthUpstreamError("OAuth upstream response is too large");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OAuthUpstreamError("OAuth upstream response is not JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new OAuthUpstreamError("OAuth upstream response shape is invalid");
  const object = payload as OAuthPayload;
  if (typeof object.error === "string")
    throw new OAuthUpstreamError("OAuth provider returned an error");
  if (!response.ok)
    throw new OAuthUpstreamError("OAuth provider returned an HTTP error");
  return object;
}

function normalizeUser(payload: OAuthPayload): AuthUser {
  const candidates = [
    payload,
    payload.user,
    payload.data,
    payload.data && typeof payload.data === "object"
      ? (payload.data as OAuthPayload).attributes
      : undefined,
  ].filter((value): value is OAuthPayload =>
    Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  const source = candidates.find((value) => value.id !== undefined) || {};
  const id = source.id;
  if (!isFlarumUserId(id))
    throw new OAuthUpstreamError("OAuth user response has no valid user id");
  const userId = String(id);
  const username =
    textValue(source.username) || textValue(source.name) || `user-${userId}`;
  const displayName =
    textValue(source.displayName) || textValue(source.display_name) || username;
  const avatarUrl =
    textValue(source.avatarUrl) ||
    textValue(source.avatar_url) ||
    textValue(source.avatar) ||
    "";
  return { id: userId, username, displayName, avatarUrl };
}

function isFlarumUserId(value: unknown): value is string | number {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && /^[1-9]\d*$/.test(value.trim());
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
