import type { ServerConfig } from "../config.js";
import { HttpError } from "../errors.js";

export function safeReturnTo(value: string | undefined, config: ServerConfig) {
  const candidate = value?.trim() || "/";
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  )
    throw new HttpError(
      400,
      "bad_request",
      "Return path must be an internal path",
    );
  const url = new URL(candidate, config.appOrigin);
  if (url.origin !== config.appOrigin.origin)
    throw new HttpError(
      400,
      "bad_request",
      "Return path must be an internal path",
    );
  return `${url.pathname}${url.search}${url.hash}`;
}
