import type { Request, Response } from "express";

export const SESSION_COOKIE = "canvas_session";
export const OAUTH_TRANSACTION_COOKIE = "canvas_oauth_transaction";

export function readCookie(req: Request, name: string) {
  const header = req.header("cookie") || "";
  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(parts.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearCookie(res: Response, name: string, secure: boolean) {
  setCookie(res, name, "", { maxAge: 0, secure });
}
