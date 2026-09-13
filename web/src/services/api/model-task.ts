import { MANAGED_PROVIDER_MARKER, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelTaskOutput = { kind: "images"; items: Array<{ url?: string; dataUrl?: string }> } | { kind: "text"; text: string } | { kind: "binary"; contentType: string; base64: string } | Record<string, unknown> | null;

type BffModelTask = {
    id: string;
    modelId: string;
    capability: ModelCapability;
    priceVersion: string;
    amount: number;
    status: "created" | "held" | "running" | "succeeded" | "failed" | "pending_reconciliation";
    providerStatus: string | null;
    result?: ModelTaskOutput;
    errorCode: string | null;
    errorMessage: string | null;
};

type CapabilityGrant = {
    token: string;
    expiresAt: number;
    target: { baseUrl: string; model: string };
    task: BffModelTask;
};

export type CapabilityProxyRequest = {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers: Record<string, string>;
    params?: Record<string, unknown>;
    data?: unknown;
    responseType?: "json" | "blob" | "text" | "arraybuffer";
};

const CAPABILITY_HEADER = "X-Canvas-Capability";

class ModelTaskApiError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ModelTaskApiError";
    }
}

type SubmitModelTaskInput = {
    config: Pick<AiConfig, "model" | "baseUrl" | "apiKey">;
    capability: ModelCapability;
    prompt?: string;
    messages?: unknown[];
    params: Record<string, unknown>;
    references?: Array<{ dataUrl: string; mimeType?: string }>;
    signal?: AbortSignal;
};

let publicKeyPromise: Promise<CryptoKey> | null = null;

export async function submitModelTask(input: SubmitModelTaskInput): Promise<BffModelTask> {
    const idempotencyKey = crypto.randomUUID();
    return retryWithFreshProviderKey(() => submit(input, input.signal, idempotencyKey));
}

async function submit(input: SubmitModelTaskInput, signal: AbortSignal | undefined, idempotencyKey: string): Promise<BffModelTask> {
    const apiKeyEnvelope = await encryptProviderKey(input.config.apiKey, signal);
    const payload = await requestJson(
        "/api/model-tasks",
        {
            method: "POST",
            body: JSON.stringify({
                modelId: input.config.model,
                capability: input.capability,
                ...(input.prompt ? { prompt: input.prompt } : {}),
                ...(input.messages?.length ? { messages: input.messages } : {}),
                params: input.params,
                references: input.references || [],
                idempotencyKey,
                apiKeyEnvelope,
            }),
            signal,
        },
        "Model request failed",
    );
    if (!isTaskEnvelope(payload)) throw new ModelTaskApiError("invalid_response", "Model service returned an invalid task");
    return waitForTask(payload.task, signal);
}

export async function fetchWalletBalance(signal?: AbortSignal) {
    const payload = await requestJson("/api/wallet", { signal }, "Wallet service is unavailable");
    if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true || !Number.isSafeInteger((payload as { balance?: unknown }).balance) || (payload as { balance: number }).balance < 0) {
        throw new ModelTaskApiError("wallet_unavailable", "Wallet service returned an invalid balance");
    }
    return (payload as { balance: number }).balance;
}

export async function fetchModelTask(id: string, signal?: AbortSignal): Promise<BffModelTask> {
    const payload = await requestJson(`/api/model-tasks/${encodeURIComponent(id)}`, { signal }, "Model task service is unavailable");
    if (!isTaskEnvelope(payload)) throw new ModelTaskApiError("invalid_response", "Model service returned an invalid task");
    return payload.task;
}

type StartModelCapabilityInput = {
    config: Pick<AiConfig, "model" | "baseUrl" | "apiKey">;
    capability: ModelCapability;
    scriptHash: string;
    prompt?: string;
    messages?: unknown[];
    params: Record<string, unknown>;
    references?: Array<{ dataUrl: string; mimeType?: string }>;
    signal?: AbortSignal;
};

export async function startModelCapability(input: StartModelCapabilityInput): Promise<CapabilityGrant> {
    const idempotencyKey = crypto.randomUUID();
    return retryWithFreshProviderKey(() => startModelCapabilityRequest(input, idempotencyKey));
}

async function startModelCapabilityRequest(input: StartModelCapabilityInput, idempotencyKey: string): Promise<CapabilityGrant> {
    const apiKeyEnvelope = await encryptProviderKey(input.config.apiKey, input.signal);
    const payload = await requestJson(
        "/api/model-capabilities",
        {
            method: "POST",
            body: JSON.stringify({
                modelId: input.config.model,
                capability: input.capability,
                ...(input.prompt ? { prompt: input.prompt } : {}),
                ...(input.messages?.length ? { messages: input.messages } : {}),
                params: input.params,
                references: input.references || [],
                idempotencyKey,
                apiKeyEnvelope,
                scriptHash: input.scriptHash,
            }),
            signal: input.signal,
        },
        "Model capability request failed",
    );
    if (!payload || typeof payload !== "object") throw new ModelTaskApiError("invalid_response", "Model service returned an invalid capability");
    const value = payload as { capability?: unknown; target?: unknown; task?: unknown };
    const capability = value.capability as { token?: unknown; expiresAt?: unknown } | null;
    const target = value.target as { baseUrl?: unknown; model?: unknown } | null;
    const task = value.task as BffModelTask | undefined;
    if (!task || typeof task.id !== "string") throw new ModelTaskApiError("invalid_response", "Model service returned an invalid capability task");
    if (!capability || typeof capability.token !== "string" || !Number.isSafeInteger(capability.expiresAt) || !target || typeof target.baseUrl !== "string" || typeof target.model !== "string") {
        throw new ModelTaskApiError(task.errorCode || task.status, task.errorMessage || "Model capability could not be created");
    }
    return { token: capability.token, expiresAt: capability.expiresAt as number, target: { baseUrl: target.baseUrl, model: target.model }, task };
}

export async function requestModelCapability(token: string, apiKey: string, input: CapabilityProxyRequest, signal?: AbortSignal) {
    return retryWithFreshProviderKey(async () => {
        const apiKeyEnvelope = await encryptProviderKey(apiKey, signal);
        const payload = await requestJson("/api/model-capabilities/request", { method: "POST", headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ ...input, apiKeyEnvelope }), signal }, "Model provider request failed");
        if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
            throw new ModelTaskApiError("invalid_response", "Model service returned an invalid provider response");
        }
        return (payload as { data?: unknown }).data;
    });
}

export async function completeModelCapability(token: string, success: boolean, result?: unknown, error?: string, signal?: AbortSignal) {
    const payload = await requestJson(
        "/api/model-capabilities/complete",
        { method: "POST", headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ success, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) }), signal },
        "Model billing completion failed",
    );
    if (!isTaskEnvelope(payload)) throw new ModelTaskApiError("invalid_response", "Model service returned an invalid completion");
    return payload.task;
}

export async function abandonModelCapability(token: string, signal?: AbortSignal) {
    try {
        const payload = await requestJson("/api/model-capabilities/abandon", { method: "POST", headers: { [CAPABILITY_HEADER]: token }, body: "{}", signal }, "Model capability abandonment failed");
        return isTaskEnvelope(payload) ? payload.task : null;
    } catch {
        return null;
    }
}

export function taskOutput(task: BffModelTask): ModelTaskOutput {
    if (task.status === "succeeded") return task.result || null;
    throw new ModelTaskApiError(task.errorCode || task.status, task.errorMessage || "Model task did not complete");
}

async function waitForTask(task: BffModelTask, signal?: AbortSignal): Promise<BffModelTask> {
    if (!["created", "held", "running"].includes(task.status)) return task;
    let current = task;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        await delay(500, signal);
        current = await fetchModelTask(current.id, signal);
        if (!["created", "held", "running"].includes(current.status)) return current;
    }
    return current;
}

async function encryptProviderKey(value: string, signal?: AbortSignal) {
    if (value === MANAGED_PROVIDER_MARKER) return undefined;
    if (!value.trim()) throw new ModelTaskApiError("bad_request", "Provider credential is required");
    const key = await encryptionKey(signal);
    const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(value));
    return base64Url(new Uint8Array(encrypted));
}

function encryptionKey(signal?: AbortSignal) {
    publicKeyPromise ||= fetch("/auth/public-key", { credentials: "include", cache: "no-store", signal })
        .then(async (response) => {
            if (!response.ok) throw new ModelTaskApiError("public_key_unavailable", "Model service is unavailable");
            const pem = await response.text();
            const encoded = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
            return crypto.subtle.importKey("spki", fromBase64(encoded), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        })
        .catch((error: unknown) => {
            publicKeyPromise = null;
            throw error;
        });
    return publicKeyPromise;
}

async function requestJson(path: string, init: RequestInit, fallback: string): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(path, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new ModelTaskApiError("service_unavailable", fallback);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw apiError(response.status, payload, fallback);
    return payload;
}

function apiError(status: number, payload: unknown, fallback: string) {
    if (status === 401) useUserStore.getState().clearSession();
    const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
    if (error && typeof error === "object") {
        const record = error as { code?: unknown; message?: unknown };
        return new ModelTaskApiError(typeof record.code === "string" ? record.code : "request_failed", typeof record.message === "string" ? record.message : fallback);
    }
    return new ModelTaskApiError("request_failed", fallback);
}

function isTaskEnvelope(value: unknown): value is { ok: true; task: BffModelTask } {
    if (!value || typeof value !== "object") return false;
    const task = (value as { task?: unknown }).task;
    return (value as { ok?: unknown }).ok === true && Boolean(task && typeof task === "object" && typeof (task as { id?: unknown }).id === "string");
}

function fromBase64(value: string) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function base64Url(bytes: Uint8Array) {
    let value = "";
    bytes.forEach((byte) => {
        value += String.fromCharCode(byte);
    });
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function retryWithFreshProviderKey<T>(operation: () => Promise<T>) {
    try {
        return await operation();
    } catch (error) {
        if (!(error instanceof ModelTaskApiError) || error.code !== "credential_envelope_invalid") throw error;
        publicKeyPromise = null;
        return operation();
    }
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
