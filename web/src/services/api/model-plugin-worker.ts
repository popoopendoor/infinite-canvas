import type { CapabilityProxyRequest as ProxyRequest } from "./model-task";

type RunMessage = {
    type: "run";
    script: string;
    prompt: string;
    images: string[];
    videos: File[];
    audios: File[];
    messages: unknown[];
    params: Record<string, unknown>;
    model: string;
    baseUrl: string;
    apiKey: string;
    systemPrompt: string;
    reasoningEffort: string;
};

type AbortMessage = { type: "abort" };

type PortMessage = { type: "proxy-response"; requestId: string; data: unknown } | { type: "proxy-error"; requestId: string; error: SerializedError };

type SerializedError = { name: string; message: string };

const pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

self.onmessage = (event: MessageEvent<RunMessage | AbortMessage>) => {
    if (event.data.type === "abort") {
        runController?.abort();
        for (const pending of pendingRequests.values()) pending.reject(new DOMException("Aborted", "AbortError"));
        pendingRequests.clear();
        return;
    }
    runController = new AbortController();
    const port = event.ports[0];
    if (!port) return;
    port.onmessage = (portEvent: MessageEvent<PortMessage>) => {
        if (portEvent.data.type === "proxy-response") {
            const pending = pendingRequests.get(portEvent.data.requestId);
            if (!pending) return;
            pendingRequests.delete(portEvent.data.requestId);
            pending.resolve(portEvent.data.data);
            return;
        }
        const pending = pendingRequests.get(portEvent.data.requestId);
        if (!pending) return;
        pendingRequests.delete(portEvent.data.requestId);
        pending.reject(errorFrom(portEvent.data.error));
    };
    port.start();
    void run(event.data, runController.signal, port);
};

let runController: AbortController | null = null;

async function run(input: RunMessage, signal: AbortSignal, port: MessagePort) {
    try {
        const result = await runScript(input, signal, port);
        if (result === undefined) throw new Error("Model script did not return a result");
        port.postMessage({ type: "completed", result });
    } catch (error) {
        port.postMessage({ type: "failed", error: serializeError(error) });
    }
}

async function runScript(input: RunMessage, signal: AbortSignal, port: MessagePort) {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    blockDirectNetwork();
    const request = createRequest(port);
    const http = createHttp(request);
    const poll = createPoll(signal);
    const runner = new Function(
        "prompt",
        "images",
        "videos",
        "audios",
        "messages",
        "params",
        "model",
        "baseUrl",
        "apiKey",
        "systemPrompt",
        "reasoningEffort",
        "http",
        "request",
        "poll",
        "sleep",
        "signal",
        "onDelta",
        "fetch",
        "XMLHttpRequest",
        `"use strict"; return (async () => {\n${input.script}\n})();`,
    ) as (...args: unknown[]) => Promise<unknown>;
    return runner(
        input.prompt,
        input.images,
        input.videos,
        input.audios,
        input.messages,
        input.params,
        input.model,
        input.baseUrl,
        input.apiKey,
        input.systemPrompt,
        input.reasoningEffort,
        http,
        request,
        poll,
        sleep,
        signal,
        (value: unknown) => emitDelta(port, value),
        (value: RequestInfo | URL, init?: RequestInit) => safeDataFetch(nativeFetch, value, init),
        undefined,
    );
}

function createHttp(request: ReturnType<typeof createRequest>) {
    return {
        url: (path: string) => path,
        post: (path: string, body?: unknown, options?: RequestOptions) => request({ method: "POST", url: path, headers: options?.headers || {}, params: options?.params, data: body, responseType: options?.responseType }),
        get: (path: string, options?: RequestOptions) => request({ method: "GET", url: path, headers: options?.headers || {}, params: options?.params, responseType: options?.responseType }),
    };
}

function createRequest(port: MessagePort) {
    return async (value: Partial<ProxyRequest> & { url: string }) => {
        const requestId = crypto.randomUUID();
        const request: ProxyRequest = {
            method: normalizeMethod(value.method),
            url: value.url,
            headers: value.headers || {},
            ...(value.params === undefined ? {} : { params: value.params }),
            ...(value.data === undefined ? {} : { data: await serializeData(value.data) }),
            ...(value.responseType ? { responseType: value.responseType } : {}),
        };
        return new Promise<unknown>((resolve, reject) => {
            pendingRequests.set(requestId, { resolve, reject });
            port.postMessage({ type: "proxy-request", requestId, request });
        });
    };
}

function normalizeMethod(value: unknown): ProxyRequest["method"] {
    const method = String(value || "GET").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return method as ProxyRequest["method"];
    throw new Error("Model script request method is not allowed");
}

async function serializeData(value: unknown): Promise<unknown> {
    if (!(value instanceof FormData)) return value;
    const fields: Array<{ name: string; value: string | { kind: "file"; name: string; type: string; base64: string } }> = [];
    for (const [name, item] of value.entries()) {
        if (typeof item === "string") fields.push({ name, value: item });
        else fields.push({ name, value: { kind: "file", name: item.name || "upload.bin", type: item.type || "application/octet-stream", base64: base64FromBytes(new Uint8Array(await item.arrayBuffer())) } });
    }
    return { kind: "form", fields };
}

function createPoll(signal: AbortSignal) {
    return async function poll<T, R>(request: () => Promise<T>, extract: (value: T) => R | null | undefined | false, options?: { intervalMs?: number; timeoutMs?: number }): Promise<R> {
        const intervalMs = options?.intervalMs ?? 2500;
        const deadline = performance.now() + (options?.timeoutMs ?? 300000);
        for (;;) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            const result = extract(await request());
            if (result !== null && result !== undefined && result !== false) return result;
            if (performance.now() >= deadline) throw new Error("Model script polling timed out");
            await sleep(intervalMs, signal);
        }
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function emitDelta(port: MessagePort, value: unknown) {
    if (typeof value === "string") port.postMessage({ type: "delta", value });
}

function safeDataFetch(nativeFetch: typeof fetch, input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!/^(data|blob):/i.test(url)) throw new Error("Direct provider fetch is not allowed");
    return nativeFetch(input, init);
}

function blockDirectNetwork() {
    globalThis.fetch = (() => Promise.reject(new Error("Direct provider fetch is not allowed"))) as typeof fetch;
    globalThis.XMLHttpRequest = class {
        constructor() {
            throw new Error("Direct provider XMLHttpRequest is not allowed");
        }
    } as typeof XMLHttpRequest;
}

function serializeError(error: unknown): SerializedError {
    return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

function errorFrom(value: SerializedError) {
    const error = new Error(value.message);
    error.name = value.name;
    return error;
}

function base64FromBytes(bytes: Uint8Array) {
    let value = "";
    bytes.forEach((byte) => {
        value += String.fromCharCode(byte);
    });
    return btoa(value);
}

type RequestOptions = {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    responseType?: ProxyRequest["responseType"];
};
