import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decryptSecret } from "../crypto.js";
import { HttpError } from "../errors.js";
import type { ServerConfig } from "../config.js";
import {
  providerModel,
  type CatalogEntry,
  type ModelRequest,
} from "../billing/catalog.js";

export type ProviderResult = { providerStatus: string; output: unknown };

export type ProviderProxyRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  responseType?: "json" | "blob" | "text" | "arraybuffer";
};

export class ProviderUnknownError extends Error {
  constructor() {
    super("Provider result is unknown");
    this.name = "ProviderUnknownError";
  }
}

export interface ProviderExecutor {
  execute(entry: CatalogEntry, request: ModelRequest): Promise<ProviderResult>;
  validate?(entry: CatalogEntry, request: ModelRequest): Promise<void>;
  proxy?(
    entry: CatalogEntry,
    request: ProviderProxyRequest,
    apiKeyEnvelope: string | undefined,
  ): Promise<unknown>;
}

export class HttpProviderExecutor implements ProviderExecutor {
  constructor(
    private readonly config: ServerConfig,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async validate(entry: CatalogEntry, request: ModelRequest) {
    readApiKey(request.apiKeyEnvelope, this.config.modelProviderKeys[entry.id]);
    await providerBaseUrl(entry.baseUrl, this.config);
  }

  async execute(
    entry: CatalogEntry,
    request: ModelRequest,
  ): Promise<ProviderResult> {
    const apiKey = readApiKey(
      request.apiKeyEnvelope,
      this.config.modelProviderKeys[entry.id],
    );
    const baseUrl = await providerBaseUrl(entry.baseUrl, this.config);
    if (entry.capability === "video")
      return this.executeVideo(entry, request, apiKey, baseUrl);
    const payload = await this.send(entry, request, apiKey, baseUrl);
    return { providerStatus: "succeeded", output: payload };
  }

  async proxy(
    entry: CatalogEntry,
    request: ProviderProxyRequest,
    apiKeyEnvelope: string | undefined,
  ) {
    const apiKey = readApiKey(
      apiKeyEnvelope,
      this.config.modelProviderKeys[entry.id],
    );
    const baseUrl = await providerBaseUrl(entry.baseUrl, this.config);
    const target = proxyTarget(entry, request, baseUrl);
    const headers = proxyHeaders(entry, request.headers, apiKey);
    const body = await proxyBody(entry, request.data, headers);
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderUnknownError();
    }
    if (!response.ok)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider rejected the request",
        { status: response.status },
      );
    return parseProxyResponse(response, request.responseType);
  }

  private async executeVideo(
    entry: CatalogEntry,
    request: ModelRequest,
    apiKey: string,
    baseUrl: URL,
  ): Promise<ProviderResult> {
    const initial = await this.fetchJson(
      providerUrl(entry, baseUrl, request),
      await providerRequest(entry, request, apiKey),
    );
    if (entry.provider === "gemini")
      return this.pollGeminiVideo(apiKey, baseUrl, initial);
    return this.pollOpenAiVideo(entry.provider, apiKey, baseUrl, initial);
  }

  private async pollOpenAiVideo(
    provider: CatalogEntry["provider"],
    apiKey: string,
    baseUrl: URL,
    initial: unknown,
  ): Promise<ProviderResult> {
    let payload = initial;
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const status = videoStatus(payload);
      if (status === "completed" || status === "succeeded")
        return {
          providerStatus: "succeeded",
          output: await this.videoOutput(provider, apiKey, baseUrl, payload),
        };
      if (status === "failed" || status === "cancelled")
        throw new HttpError(
          502,
          "upstream_error",
          "Model provider rejected the video request",
        );
      const id = videoId(payload);
      if (!id)
        throw new HttpError(502, "upstream_error", "Video task ID is missing");
      if (Date.now() >= deadline) throw new ProviderUnknownError();
      await delay(1000);
      payload = await this.fetchJson(
        new URL(
          `${baseUrl.toString().replace(/\/$/, "")}/v1/videos/${encodeURIComponent(id)}`,
        ),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
        },
      );
    }
  }

  private async pollGeminiVideo(
    apiKey: string,
    baseUrl: URL,
    initial: unknown,
  ): Promise<ProviderResult> {
    let payload = initial;
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const operation = payload as {
        name?: unknown;
        done?: unknown;
        error?: { message?: unknown };
        response?: {
          generateVideoResponse?: {
            generatedSamples?: Array<{ video?: { uri?: unknown } }>;
          };
        };
      };
      if (operation.error)
        throw new HttpError(
          502,
          "upstream_error",
          "Model provider rejected the video request",
        );
      if (operation.done === true) {
        const uri =
          operation.response?.generateVideoResponse?.generatedSamples?.[0]
            ?.video?.uri;
        if (typeof uri !== "string" || !uri)
          throw new HttpError(
            502,
            "upstream_error",
            "Video provider returned no media",
          );
        return {
          providerStatus: "succeeded",
          output: await this.fetchVideoBinary("gemini", uri, apiKey, baseUrl),
        };
      }
      if (typeof operation.name !== "string" || !operation.name)
        throw new HttpError(
          502,
          "upstream_error",
          "Video operation name is missing",
        );
      if (Date.now() >= deadline) throw new ProviderUnknownError();
      await delay(1000);
      payload = await this.fetchJson(
        new URL(
          `${baseUrl.toString().replace(/\/$/, "")}/v1beta/${operation.name.replace(/^\//, "")}`,
        ),
        {
          method: "GET",
          headers: { accept: "application/json", "x-goog-api-key": apiKey },
        },
      );
    }
  }

  private async videoOutput(
    provider: CatalogEntry["provider"],
    apiKey: string,
    baseUrl: URL,
    payload: unknown,
  ) {
    const url = videoUrl(payload);
    if (url) return this.fetchVideoBinary(provider, url, apiKey, baseUrl);
    const id = videoId(payload);
    if (!id)
      throw new HttpError(502, "upstream_error", "Video media is missing");
    return this.fetchVideoBinary(
      provider,
      `/v1/videos/${encodeURIComponent(id)}/content`,
      apiKey,
      baseUrl,
    );
  }

  private async fetchVideoBinary(
    provider: CatalogEntry["provider"],
    value: string,
    apiKey: string,
    baseUrl: URL,
  ) {
    return this.fetchMediaBinary(
      provider,
      value,
      apiKey,
      baseUrl,
      "video/*,application/octet-stream",
      "video/mp4",
    );
  }

  private async fetchJson(target: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(target, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderUnknownError();
    }
    const text = await response.text();
    if (text.length > 1_000_000)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider response is too large",
      );
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider returned invalid JSON",
      );
    }
    if (!response.ok)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider rejected the request",
        { status: response.status },
      );
    return payload;
  }

  private async send(
    entry: CatalogEntry,
    request: ModelRequest,
    apiKey: string,
    baseUrl: URL,
  ) {
    const target = providerUrl(entry, baseUrl, request);
    const init = await providerRequest(entry, request, apiKey);
    let response: Response;
    try {
      response = await this.fetcher(target, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new ProviderUnknownError();
      if (error instanceof Error && error.name === "AbortError")
        throw new ProviderUnknownError();
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider is unavailable",
      );
    }
    if (!response.ok)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider rejected the request",
        { status: response.status },
      );
    const contentType = response.headers.get("content-type") || "";
    if (
      (entry.capability === "audio" || entry.capability === "video") &&
      !contentType.toLowerCase().includes("json")
    ) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 40_000_000)
        throw new HttpError(
          502,
          "upstream_error",
          "Model provider response is too large",
        );
      return {
        kind: "binary",
        contentType: contentType || "application/octet-stream",
        base64: Buffer.from(bytes).toString("base64"),
      };
    }
    const text = await response.text();
    if (text.length > 40_000_000)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider response is too large",
      );
    if (!text) return null;
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return { kind: "text", text };
    }
    return this.materializeImageOutput(entry, json, apiKey, baseUrl);
  }

  private async materializeImageOutput(
    entry: CatalogEntry,
    value: unknown,
    apiKey: string,
    baseUrl: URL,
  ) {
    const output = normalizeProviderOutput(entry, value);
    if (
      !output ||
      typeof output !== "object" ||
      (output as { kind?: unknown }).kind !== "images" ||
      !Array.isArray((output as { items?: unknown }).items)
    )
      return output;
    const items = await Promise.all(
      (
        output as { items: Array<{ dataUrl?: string; url?: string }> }
      ).items.map(async (item) =>
        item.url
          ? {
              dataUrl: await this.fetchImageDataUrl(
                entry.provider,
                item.url,
                apiKey,
                baseUrl,
              ),
            }
          : item,
      ),
    );
    return { kind: "images", items };
  }

  private async fetchImageDataUrl(
    provider: CatalogEntry["provider"],
    value: string,
    apiKey: string,
    baseUrl: URL,
  ) {
    const binary = await this.fetchMediaBinary(
      provider,
      value,
      apiKey,
      baseUrl,
      "image/*,application/octet-stream",
      "image/png",
    );
    return `data:${binary.contentType};base64,${binary.base64}`;
  }

  private async fetchMediaBinary(
    provider: CatalogEntry["provider"],
    value: string,
    apiKey: string,
    baseUrl: URL,
    accept: string,
    fallbackContentType: string,
  ) {
    let target: URL;
    try {
      target = providerMediaTarget(value, baseUrl);
    } catch {
      throw new ProviderUnknownError();
    }
    if (
      target.origin !== baseUrl.origin ||
      target.protocol !== baseUrl.protocol ||
      target.username ||
      target.password
    )
      throw new ProviderUnknownError();
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method: "GET",
        headers: {
          accept,
          ...providerAuthHeaders(provider, apiKey),
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderUnknownError();
    }
    if (!response.ok) throw new ProviderUnknownError();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 40_000_000)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider response is too large",
      );
    return {
      kind: "binary",
      contentType: response.headers.get("content-type") || fallbackContentType,
      base64: Buffer.from(bytes).toString("base64"),
    };
  }
}

function providerMediaTarget(value: string, baseUrl: URL) {
  const target = new URL(value, baseUrl);
  if (
    target.protocol === "http:" &&
    baseUrl.protocol === "https:" &&
    target.hostname === baseUrl.hostname &&
    target.port === baseUrl.port
  )
    target.protocol = "https:";
  return target;
}

function proxyTarget(
  entry: CatalogEntry,
  request: ProviderProxyRequest,
  baseUrl: URL,
) {
  let target: URL;
  try {
    target = new URL(request.url, baseUrl);
  } catch {
    throw new HttpError(400, "bad_request", "Provider request URL is invalid");
  }
  if (
    target.origin !== baseUrl.origin ||
    target.protocol !== baseUrl.protocol ||
    target.username ||
    target.password
  )
    throw new HttpError(
      400,
      "bad_request",
      "Provider request URL is not allowed",
    );
  for (const key of [...target.searchParams.keys()])
    if (isCredentialQueryKey(key)) target.searchParams.delete(key);
    else if (isModelKey(key))
      target.searchParams.set(key, providerModel(entry));
  if (request.params)
    for (const [key, value] of Object.entries(request.params)) {
      if (isCredentialQueryKey(key)) continue;
      if (isModelKey(key)) {
        target.searchParams.set(key, providerModel(entry));
        continue;
      }
      if (Array.isArray(value))
        value.forEach((item) =>
          target.searchParams.append(key, queryValue(item)),
        );
      else target.searchParams.set(key, queryValue(value));
    }
  if (entry.provider === "gemini")
    target.pathname = target.pathname.replace(
      /(\/models\/)[^/:]+(?=[:/]|$)/,
      `$1${encodeURIComponent(providerModel(entry))}`,
    );
  return target;
}

function isCredentialQueryKey(key: string) {
  return ["key", "api_key", "apikey", "access_token", "token"].includes(
    key.toLowerCase(),
  );
}

function isModelKey(key: string) {
  return ["model", "model_id", "modelid"].includes(key.toLowerCase());
}

function proxyHeaders(
  entry: CatalogEntry,
  input: Record<string, string>,
  apiKey: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (
      /^(authorization|x-api-key|api-key|api_key|x-goog-api-key|cookie|host|content-length)$/i.test(
        key,
      )
    )
      continue;
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(
    providerAuthHeaders(entry.provider, apiKey),
  ))
    headers.set(key, value);
  return headers;
}

function providerAuthHeaders(
  provider: CatalogEntry["provider"],
  apiKey: string,
): Record<string, string> {
  return provider === "gemini"
    ? { "x-goog-api-key": apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

async function proxyBody(
  entry: CatalogEntry,
  value: unknown,
  headers: Headers,
): Promise<BodyInit | undefined> {
  if (value === undefined) return undefined;
  if (isProxyForm(value)) {
    const form = new FormData();
    for (const field of value.fields) {
      if (isModelKey(field.name)) form.append(field.name, providerModel(entry));
      else if (typeof field.value === "string")
        form.append(field.name, field.value);
      else
        form.append(
          field.name,
          new Blob([Buffer.from(field.value.base64, "base64")], {
            type: field.value.type,
          }),
          field.value.name,
        );
    }
    headers.delete("content-type");
    return form;
  }
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json");
  return typeof value === "string"
    ? replaceModelInJson(value, entry)
    : JSON.stringify(replaceModelValues(value, entry));
}

function replaceModelInJson(value: string, entry: CatalogEntry) {
  try {
    return JSON.stringify(replaceModelValues(JSON.parse(value), entry));
  } catch {
    return value;
  }
}

function replaceModelValues(value: unknown, entry: CatalogEntry): unknown {
  if (Array.isArray(value))
    return value.map((item) => replaceModelValues(item, entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isModelKey(key) ? providerModel(entry) : replaceModelValues(item, entry),
    ]),
  );
}

function isProxyForm(value: unknown): value is ProxyForm {
  if (!value || typeof value !== "object") return false;
  const form = value as { kind?: unknown; fields?: unknown };
  return form.kind === "form" && Array.isArray(form.fields);
}

type ProxyForm = {
  kind: "form";
  fields: Array<{
    name: string;
    value:
      string | { kind: "file"; name: string; type: string; base64: string };
  }>;
};

function queryValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

async function parseProxyResponse(
  response: Response,
  responseType?: ProviderProxyRequest["responseType"],
) {
  const contentType = response.headers.get("content-type") || "";
  if (responseType === "text") {
    const text = await response.text();
    if (text.length > 40_000_000)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider response is too large",
      );
    return { kind: "text", text };
  }
  if (
    responseType === "blob" ||
    responseType === "arraybuffer" ||
    !contentType.toLowerCase().includes("json")
  ) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 40_000_000)
      throw new HttpError(
        502,
        "upstream_error",
        "Model provider response is too large",
      );
    return {
      kind: "binary",
      contentType: contentType || "application/octet-stream",
      base64: Buffer.from(bytes).toString("base64"),
    };
  }
  const text = await response.text();
  if (text.length > 40_000_000)
    throw new HttpError(
      502,
      "upstream_error",
      "Model provider response is too large",
    );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { kind: "text", text };
  }
}

function readApiKey(envelope: string | undefined, managedKey?: string) {
  if (managedKey) return managedKey;
  if (!envelope)
    throw new HttpError(400, "bad_request", "Provider credential is required");
  try {
    const value = decryptSecret(envelope);
    if (!value.trim()) throw new Error("empty");
    return value;
  } catch {
    throw new HttpError(
      400,
      "credential_envelope_invalid",
      "Provider credential envelope is invalid",
    );
  }
}

async function providerBaseUrl(
  value: string | undefined,
  config: ServerConfig,
) {
  if (!value)
    throw new HttpError(400, "bad_request", "Provider base URL is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "bad_request", "Provider base URL is invalid");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new HttpError(400, "bad_request", "Provider base URL is invalid");
  if (config.nodeEnv === "production" && url.protocol !== "https:")
    throw new HttpError(400, "bad_request", "Provider base URL must use HTTPS");
  const host = url.hostname.toLowerCase();
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  if (
    config.nodeEnv === "production" &&
    config.providerBaseUrlAllowlist.length === 0
  )
    throw new HttpError(
      503,
      "service_unavailable",
      "Provider base URL allowlist is not configured",
    );
  if (
    config.providerBaseUrlAllowlist.length
      ? !config.providerBaseUrlAllowlist.includes(normalizedHost)
      : privateHost(normalizedHost)
  )
    throw new HttpError(400, "bad_request", "Provider base URL is not allowed");
  if (isIP(normalizedHost) && privateHost(normalizedHost))
    throw new HttpError(
      400,
      "bad_request",
      "Provider base URL resolves to a private address",
    );
  if (!isIP(normalizedHost)) {
    const addresses = await lookup(normalizedHost, { all: true }).catch(
      () => [],
    );
    if (
      !addresses.length ||
      addresses.some((address) => privateHost(address.address))
    )
      throw new HttpError(
        400,
        "bad_request",
        "Provider base URL resolves to a private address",
      );
  }
  return url;
}

function privateHost(host: string) {
  const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedIpv4) return privateHost(mappedIpv4);
  if (
    host === "::" ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^fc|^fd/i.test(host) ||
    /^fe[89ab]/i.test(host) ||
    /^ff/i.test(host)
  )
    return true;
  const parts = host.split(".").map(Number);
  if (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  )
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
      (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      parts[0] >= 240
    );
  return false;
}

function providerUrl(entry: CatalogEntry, baseUrl: URL, request: ModelRequest) {
  const root = baseUrl.toString().replace(/\/$/, "");
  if (entry.provider === "gemini")
    return new URL(
      `${root}/v1beta/models/${encodeURIComponent(providerModel(entry))}:${entry.capability === "video" ? "predictLongRunning" : "generateContent"}`,
    );
  const path =
    entry.capability === "image"
      ? request.references.length
        ? "/images/edits"
        : "/images/generations"
      : entry.capability === "video"
        ? "/videos"
        : entry.capability === "audio"
          ? "/audio/speech"
          : "/chat/completions";
  return new URL(`${root.endsWith("/v1") ? root : `${root}/v1`}${path}`);
}

async function providerRequest(
  entry: CatalogEntry,
  request: ModelRequest,
  apiKey: string,
): Promise<RequestInit> {
  const model = providerModel(entry);
  if (entry.provider === "gemini") {
    if (entry.capability === "video")
      return {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          instances: [
            {
              prompt: request.prompt || "",
              referenceImages: request.references.map((reference) => ({
                image: imagePart(reference.dataUrl, reference.mimeType)
                  .inlineData,
                referenceType: "asset",
              })),
            },
          ],
          parameters: request.params,
        }),
      };
    return {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: request.prompt || JSON.stringify(request.messages || []),
              },
              ...request.references.map((reference) =>
                imagePart(reference.dataUrl, reference.mimeType),
              ),
            ],
          },
        ],
      }),
    };
  }
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (entry.capability === "image" && request.references.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(imageParameters(model, request)))
      form.set(key, String(value));
    for (const [index, reference] of request.references.entries()) {
      const { bytes, mimeType } = decodeImageReference(reference);
      form.append(
        request.references.length === 1 ? "image" : "image[]",
        new Blob([bytes], { type: mimeType }),
        `reference-${index + 1}.${extensionForMimeType(mimeType)}`,
      );
    }
    return {
      method: "POST",
      headers: { authorization: headers.authorization },
      body: form,
    };
  }
  if (entry.capability === "image")
    return {
      method: "POST",
      headers,
      body: JSON.stringify(imageParameters(model, request)),
    };
  if (entry.capability === "video")
    return {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        prompt: request.prompt,
        ...(request.references.length
          ? { references: request.references }
          : {}),
        ...request.params,
      }),
    };
  if (entry.capability === "audio")
    return {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: request.prompt || "",
        ...request.params,
      }),
    };
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: request.messages || [
        { role: "user", content: request.prompt || "" },
      ],
      stream: false,
      ...request.params,
    }),
  };
}

function imageParameters(model: string, request: ModelRequest) {
  return {
    model,
    prompt: request.prompt || "",
    n: request.params.count || 1,
    ...(request.params.size ? { size: request.params.size } : {}),
    ...(request.params.quality ? { quality: request.params.quality } : {}),
    ...(request.params.background
      ? { background: request.params.background }
      : {}),
    ...(request.params.outputFormat
      ? { output_format: request.params.outputFormat }
      : {}),
    ...(!/gpt-image/.test(model) ? { response_format: "b64_json" } : {}),
  };
}

function imagePart(dataUrl: string, mimeType?: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return {
    inlineData: {
      mimeType: mimeType || match?.[1] || "image/png",
      data: match?.[2] || dataUrl,
    },
  };
}

function decodeImageReference(reference: ModelRequest["references"][number]) {
  const match = reference.dataUrl.match(
    /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/,
  );
  const mimeType = reference.mimeType || match?.[1] || "";
  if (!match || !mimeType.startsWith("image/"))
    throw new HttpError(400, "bad_request", "Image reference is invalid");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length)
    throw new HttpError(400, "bad_request", "Image reference is empty");
  return { bytes, mimeType };
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function normalizeProviderOutput(entry: CatalogEntry, value: unknown) {
  const capability = entry.capability;
  if (capability === "text") {
    if (entry.provider === "gemini") {
      const candidates = (
        value as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: unknown }> };
          }>;
        }
      ).candidates;
      const text = (candidates || [])
        .flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("");
      return { kind: "text", text: text || JSON.stringify(value) };
    }
    const payload = value as {
      choices?: Array<{ message?: { content?: unknown } }>;
      output_text?: unknown;
    };
    return {
      kind: "text",
      text:
        typeof payload.output_text === "string"
          ? payload.output_text
          : typeof payload.choices?.[0]?.message?.content === "string"
            ? payload.choices[0].message.content
            : JSON.stringify(value),
    };
  }
  if (capability === "image") {
    if (entry.provider === "gemini") {
      const candidates = (
        value as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: { mimeType?: unknown; data?: unknown };
                inline_data?: { mime_type?: unknown; data?: unknown };
                fileData?: { fileUri?: unknown };
              }>;
            };
          }>;
        }
      ).candidates;
      const items: Array<{ dataUrl?: string; url?: string }> = [];
      for (const candidate of candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (typeof part.inlineData?.data === "string") {
            items.push({
              dataUrl: `data:${typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType : "image/png"};base64,${part.inlineData.data}`,
            });
          } else if (typeof part.inline_data?.data === "string") {
            items.push({
              dataUrl: `data:${typeof part.inline_data.mime_type === "string" ? part.inline_data.mime_type : "image/png"};base64,${part.inline_data.data}`,
            });
          } else if (typeof part.fileData?.fileUri === "string") {
            items.push({ url: part.fileData.fileUri });
          }
        }
      }
      return { kind: "images", items };
    }
    const items =
      (value as { data?: Array<{ url?: unknown; b64_json?: unknown }> }).data ||
      [];
    const normalized: Array<{ url?: string; dataUrl?: string }> = [];
    for (const item of items) {
      if (typeof item.url === "string") normalized.push({ url: item.url });
      else if (typeof item.b64_json === "string")
        normalized.push({ dataUrl: `data:image/png;base64,${item.b64_json}` });
    }
    return { kind: "images", items: normalized };
  }
  return value;
}

function videoId(value: unknown) {
  return value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : "";
}

function videoStatus(value: unknown) {
  return value &&
    typeof value === "object" &&
    typeof (value as { status?: unknown }).status === "string"
    ? (value as { status: string }).status.toLowerCase()
    : "";
}

function videoUrl(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const record = value as {
    url?: unknown;
    video_url?: unknown;
    result_url?: unknown;
    content?: { url?: unknown; video_url?: unknown };
  };
  return (
    [
      record.url,
      record.video_url,
      record.result_url,
      record.content?.url,
      record.content?.video_url,
    ].find(
      (item): item is string => typeof item === "string" && item.length > 0,
    ) || ""
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
