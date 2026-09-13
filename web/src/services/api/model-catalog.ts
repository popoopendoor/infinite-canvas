import type { PublishedModel } from "@/types/model-catalog";

export type { PublishedModel } from "@/types/model-catalog";

let catalogPromise: Promise<PublishedModel[] | null> | null = null;

export function fetchPublishedModels() {
    catalogPromise ||= fetch("/api/models", { credentials: "include", cache: "no-store" })
        .then(async (response) => {
            if (!response.ok) {
                catalogPromise = null;
                return null;
            }
            const payload = (await response.json().catch(() => null)) as { models?: unknown } | null;
            if (!Array.isArray(payload?.models)) {
                catalogPromise = null;
                return null;
            }
            if (!payload.models.every(isPublishedModel)) {
                catalogPromise = null;
                return null;
            }
            return payload.models;
        })
        .catch(() => {
            catalogPromise = null;
            return null;
        });
    return catalogPromise;
}

function isPublishedModel(value: unknown): value is PublishedModel {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return (
        typeof item.id === "string" &&
        Boolean(item.id.trim()) &&
        typeof item.capability === "string" &&
        ["image", "video", "text", "audio"].includes(item.capability) &&
        typeof item.provider === "string" &&
        ["openai", "gemini", "generic"].includes(item.provider) &&
        typeof item.baseUrl === "string" &&
        isHttpUrl(item.baseUrl) &&
        item.apiFormat === (item.provider === "gemini" ? "gemini" : "openai") &&
        (item.model === undefined || (typeof item.model === "string" && Boolean(item.model.trim()))) &&
        typeof item.priceVersion === "string" &&
        Boolean(item.priceVersion.trim()) &&
        (item.credentialMode === "managed" || item.credentialMode === "byok") &&
        Number.isSafeInteger(item.price) &&
        (item.price as number) >= 0
    );
}

function isHttpUrl(value: string) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
    } catch {
        return false;
    }
}
