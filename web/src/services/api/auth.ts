import type { LocalUser } from "@/stores/use-user-store";

type SessionResponse = { authenticated: false } | { authenticated: true; user: LocalUser };

export async function fetchSession(): Promise<SessionResponse> {
    const response = await fetch("/auth/session", { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") throw new Error("Authentication service is unavailable");
    if (payload.authenticated === true && isUser(payload.user)) return { authenticated: true, user: payload.user };
    if (payload.authenticated === false) return { authenticated: false };
    throw new Error("Authentication response is invalid");
}

export async function logout() {
    const response = await fetch("/auth/logout", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("Logout failed");
}

export function startLogin(returnTo: string) {
    const url = new URL("/auth/login", window.location.origin);
    url.searchParams.set("returnTo", returnTo);
    window.location.assign(url.toString());
}

function isUser(value: unknown): value is LocalUser {
    if (!value || typeof value !== "object") return false;
    const user = value as Record<string, unknown>;
    return ["id", "username", "displayName", "avatarUrl"].every((key) => typeof user[key] === "string");
}
