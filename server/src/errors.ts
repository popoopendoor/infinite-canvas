import { ZodError } from "zod";

export type ErrorCode =
  | "bad_request"
  | "credential_envelope_invalid"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "provider_unknown"
  | "wallet_unavailable"
  | "service_unavailable"
  | "internal_error";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asHttpError(error: unknown) {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError)
    return new HttpError(400, "bad_request", "Request validation failed");
  return new HttpError(500, "internal_error", "Internal server error");
}
