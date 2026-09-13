import { HttpError } from "../errors.js";
import type { ServerConfig } from "../config.js";
import { z } from "zod";

const walletResponseSchema = z.object({
  ok: z.literal(true),
  balance: z.number().int().nonnegative().safe(),
});

const ledgerResponseSchema = z.object({
  ok: z.literal(true),
  ledgerId: z.union([z.string().min(1), z.number().int().positive().safe()]),
  status: z.enum(["held", "captured", "released"]),
});

export class WalletUnknownError extends Error {
  constructor(message = "Wallet operation result is unknown") {
    super(message);
    this.name = "WalletUnknownError";
  }
}

export class BridgeClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async balance(userId: string) {
    const data = await this.request("/canvas-money/balance", {
      method: "POST",
      body: { userId },
    });
    const parsed = walletResponseSchema.safeParse(data);
    if (!parsed.success)
      throw new HttpError(
        503,
        "wallet_unavailable",
        "Wallet returned an invalid balance",
      );
    return parsed.data.balance;
  }

  hold(input: {
    userId: string;
    taskId: string;
    amount: number;
    requestHash: string;
  }) {
    return this.ledger("/canvas-money/hold", input, "held");
  }

  capture(input: {
    userId: string;
    taskId: string;
    amount: number;
    requestHash: string;
  }) {
    return this.ledger("/canvas-money/capture", input, "captured");
  }

  release(input: {
    userId: string;
    taskId: string;
    amount: number;
    requestHash: string;
  }) {
    return this.ledger("/canvas-money/release", input, "released");
  }

  private async ledger(
    path: string,
    input: Record<string, unknown>,
    expectedStatus: "held" | "captured" | "released",
  ) {
    const data = await this.request(path, { method: "POST", body: input });
    const parsed = ledgerResponseSchema.safeParse(data);
    if (!parsed.success)
      throw new WalletUnknownError(
        "Wallet returned an invalid mutation result",
      );
    if (parsed.data.status !== expectedStatus)
      throw new WalletUnknownError(
        "Wallet returned a mutation status mismatch",
      );
    return {
      ...parsed.data,
      ledgerId: String(parsed.data.ledgerId),
    };
  }

  private async request(
    path: string,
    input: { method: "POST"; body: Record<string, unknown> },
  ) {
    if (!this.config.bridgeUrl || !this.config.bridgeToken)
      throw new HttpError(
        503,
        "wallet_unavailable",
        "Wallet bridge is not configured",
      );
    let response: Response;
    try {
      response = await this.fetcher(
        new URL(
          path.replace(/^\//, ""),
          `${this.config.bridgeUrl.toString().replace(/\/$/, "")}/`,
        ),
        {
          method: input.method,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-canvas-bridge-token": this.config.bridgeToken,
          },
          body: JSON.stringify(input.body),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      if (path !== "/canvas-money/balance") throw new WalletUnknownError();
      throw new HttpError(
        503,
        "wallet_unavailable",
        "Wallet bridge is unavailable",
      );
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok && response.status >= 400 && response.status < 500) {
      const code = bridgeErrorCode(payload);
      throw new HttpError(
        response.status === 404 ? 404 : response.status === 409 ? 409 : 400,
        response.status === 404
          ? "not_found"
          : response.status === 409
            ? "conflict"
            : code === "service_unauthorized"
              ? "forbidden"
              : "bad_request",
        code || "Wallet bridge rejected the request",
      );
    }
    if (!response.ok || !payload || typeof payload !== "object") {
      if (path !== "/canvas-money/balance") throw new WalletUnknownError();
      throw new HttpError(
        503,
        "wallet_unavailable",
        "Wallet bridge returned an error",
      );
    }
    if ((payload as { ok?: unknown }).ok !== true) {
      if (path !== "/canvas-money/balance" && response.status >= 500)
        throw new WalletUnknownError();
      throw new HttpError(
        503,
        "wallet_unavailable",
        "Wallet bridge rejected the request",
      );
    }
    return payload;
  }
}

function bridgeErrorCode(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as { error?: unknown }).error;
  return typeof value === "string" ? value : "";
}
