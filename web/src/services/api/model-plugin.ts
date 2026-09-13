import i18n from "@/i18n";
import { type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { abandonModelCapability, completeModelCapability, fetchModelTask, requestModelCapability, startModelCapability, type CapabilityProxyRequest } from "./model-task";
import ModelPluginWorker from "./model-plugin-worker?worker";

type RunPluginArgs = {
    capability: ModelCapability;
    script: string;
    config: AiConfig;
    prompt?: string;
    images?: string[];
    videos?: File[];
    audios?: File[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onTask?: (task: { id: string }) => void;
};

export async function runModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    const { config } = args;
    if (!args.script.trim()) throw new Error(i18n.t("modelPlugin.scriptRequired"));
    const scriptHash = await hashScript(args.script);
    const references = [...(args.images || []).map((dataUrl) => ({ dataUrl })), ...(await fileReferences(args.videos || [])), ...(await fileReferences(args.audios || []))];
    const grant = await startModelCapability({
        config,
        capability: args.capability,
        scriptHash,
        prompt: args.prompt,
        messages: args.messages,
        params: args.params || {},
        references,
        signal: args.signal,
    });
    args.onTask?.(grant.task);
    try {
        const result = await runPluginWorker<T>(args, grant.token, grant.target);
        const resolved = await materializePluginMedia(args.capability, result, grant.token, args.config.apiKey, args.signal);
        const completed = await completeCapabilityOrRecover(grant.task.id, grant.token, await serializePluginResult(resolved), args.signal);
        if (completed.status !== "succeeded") throw new Error(i18n.t("modelPlugin.taskIncomplete"));
        return resolved as T;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            await abandonModelCapability(grant.token);
            throw error;
        }
        if (isUnknownCapabilityError(error)) {
            await abandonModelCapability(grant.token);
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        await completeModelCapability(grant.token, false, undefined, message).catch(() => undefined);
        throw new Error(i18n.t("modelPlugin.executionFailed", { message }));
    }
}

function runPluginWorker<T>(args: RunPluginArgs, token: string, target: { baseUrl: string; model: string }) {
    return new Promise<T>((resolve, reject) => {
        const worker = new ModelPluginWorker();
        const channel = new MessageChannel();
        const abort = () => {
            worker.postMessage({ type: "abort" });
            finish(() => reject(new DOMException("Aborted", "AbortError")));
        };
        const cleanup = () => {
            worker.terminate();
            channel.port1.close();
            args.signal?.removeEventListener("abort", abort);
        };
        const finish = (settle: () => void) => {
            cleanup();
            settle();
        };
        if (args.signal?.aborted) return abort();
        args.signal?.addEventListener("abort", abort, { once: true });
        channel.port1.onmessage = (event: MessageEvent<PluginWorkerMessage>) => {
            const message = event.data;
            if (message.type === "proxy-request") {
                void capabilityRequest(token, args.config.apiKey, message.request, args.signal).then(
                    (data) => channel.port1.postMessage({ type: "proxy-response", requestId: message.requestId, data }),
                    (error: unknown) => channel.port1.postMessage({ type: "proxy-error", requestId: message.requestId, error: serializeWorkerError(error) }),
                );
                return;
            }
            if (message.type === "delta") {
                args.onDelta?.(message.value);
                return;
            }
            if (message.type === "completed") return finish(() => resolve(message.result as T));
            return finish(() => reject(workerError(message.error)));
        };
        channel.port1.start();
        worker.onerror = () => finish(() => reject(new Error(i18n.t("modelPlugin.executionFailed", { message: "worker failed" }))));
        worker.postMessage(
            {
                type: "run",
                script: args.script,
                prompt: args.prompt || "",
                images: args.images || [],
                videos: args.videos || [],
                audios: args.audios || [],
                messages: args.messages || [],
                params: args.params || {},
                model: target.model,
                baseUrl: target.baseUrl,
                // Custom scripts must not receive the capability token or saved provider key.
                apiKey: "canvas-managed",
                systemPrompt: args.config.systemPrompt || "",
                reasoningEffort: args.config.reasoningEffort,
            },
            [channel.port2],
        );
    });
}

async function completeCapabilityOrRecover(taskId: string, token: string, result: unknown, signal?: AbortSignal) {
    try {
        return await completeModelCapability(token, true, result, undefined, signal);
    } catch (error) {
        const recovered = await fetchModelTask(taskId, signal).catch(() => null);
        if (recovered?.status === "succeeded") return recovered;
        throw error;
    }
}

async function fileReferences(files: File[]) {
    return Promise.all(
        files.map(async (file) => ({
            dataUrl: `data:${file.type || "application/octet-stream"};base64,${base64FromBytes(new Uint8Array(await file.arrayBuffer()))}`,
            mimeType: file.type || "application/octet-stream",
        })),
    );
}

async function capabilityRequest(token: string, apiKey: string, request: CapabilityProxyRequest, signal?: AbortSignal) {
    const data = await requestModelCapability(token, apiKey, request, signal);
    return decodeCapabilityResponse(data, request.responseType);
}

async function materializePluginMedia(capability: ModelCapability, value: unknown, token: string, apiKey: string, signal?: AbortSignal): Promise<unknown> {
    if (capability === "text") return value;
    if (typeof value === "string") {
        if (!isRemoteUrl(value)) return value;
        const media = await capabilityRequest(token, apiKey, { method: "GET", url: value, headers: {}, responseType: "blob" }, signal);
        if (!(media instanceof Blob)) throw new Error("Model media response is invalid");
        return blobDataUrl(media);
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => materializePluginMedia(capability, item, token, apiKey, signal)));
    if (!value || typeof value !== "object") return value;
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await materializePluginMedia(capability, item, token, apiKey, signal)] as const));
    return Object.fromEntries(entries);
}

function isRemoteUrl(value: string) {
    try {
        return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

function blobDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error("Could not read model media"));
        reader.readAsDataURL(blob);
    });
}

function decodeCapabilityResponse(value: unknown, responseType?: CapabilityProxyRequest["responseType"]) {
    if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "binary")
        return value && typeof value === "object" && (value as { kind?: unknown }).kind === "text" && responseType !== "json" ? (value as { text: string }).text : value;
    const binary = atob((value as { base64: string }).base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (responseType === "arraybuffer") return bytes.buffer;
    return new Blob([bytes], { type: (value as { contentType?: string }).contentType || "application/octet-stream" });
}

async function serializePluginResult(value: unknown): Promise<unknown> {
    if (value instanceof Blob) return { kind: "binary", contentType: value.type || "application/octet-stream", base64: base64FromBytes(new Uint8Array(await value.arrayBuffer())) };
    if (value instanceof ArrayBuffer) return { kind: "binary", contentType: "application/octet-stream", base64: base64FromBytes(new Uint8Array(value)) };
    if (Array.isArray(value)) return Promise.all(value.map(serializePluginResult));
    if (value && typeof value === "object") {
        const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await serializePluginResult(item)] as const));
        return Object.fromEntries(entries);
    }
    return value;
}

function base64FromBytes(bytes: Uint8Array) {
    let value = "";
    bytes.forEach((byte) => {
        value += String.fromCharCode(byte);
    });
    return btoa(value);
}

async function hashScript(script: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUnknownCapabilityError(error: unknown) {
    return error instanceof Error && "code" in error && ["provider_unknown", "service_unavailable"].includes(String((error as { code?: unknown }).code));
}

type SerializedWorkerError = { name: string; message: string };

type PluginWorkerMessage = { type: "proxy-request"; requestId: string; request: CapabilityProxyRequest } | { type: "delta"; value: string } | { type: "completed"; result: unknown } | { type: "failed"; error: SerializedWorkerError };

function serializeWorkerError(error: unknown): SerializedWorkerError {
    return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

function workerError(value: SerializedWorkerError) {
    const error = new Error(value.message);
    error.name = value.name;
    return error;
}

type PluginVariable = { name: string; type: string; desc: string; capabilities?: ModelCapability[] };

/** Documentation surface shown in the script editor. */
export function getPluginVariables(): PluginVariable[] {
    return [
        { name: "prompt", type: "string", desc: i18n.t("modelPlugin.variables.prompt"), capabilities: ["image", "video", "audio"] },
        { name: "images", type: "string[]", desc: i18n.t("modelPlugin.variables.images"), capabilities: ["image", "video"] },
        { name: "videos", type: "File[]", desc: i18n.t("modelPlugin.variables.videos"), capabilities: ["video"] },
        { name: "audios", type: "File[]", desc: i18n.t("modelPlugin.variables.audios"), capabilities: ["video"] },
        { name: "messages", type: "{ role, content }[]", desc: i18n.t("modelPlugin.variables.messages"), capabilities: ["text"] },
        { name: "params", type: "object", desc: i18n.t("modelPlugin.variables.params") },
        { name: "model", type: "string", desc: i18n.t("modelPlugin.variables.model") },
        { name: "baseUrl", type: "string", desc: i18n.t("modelPlugin.variables.baseUrl") },
        { name: "apiKey", type: "string", desc: i18n.t("modelPlugin.variables.apiKey") },
        { name: "systemPrompt", type: "string", desc: i18n.t("modelPlugin.variables.systemPrompt") },
        { name: "reasoningEffort", type: '"auto" | "low" | "medium" | "high" | "xhigh"', desc: i18n.t("modelPlugin.variables.reasoningEffort"), capabilities: ["text"] },
        { name: "http", type: "object", desc: i18n.t("modelPlugin.variables.http") },
        { name: "request", type: "function", desc: i18n.t("modelPlugin.variables.request") },
        { name: "poll", type: "function", desc: i18n.t("modelPlugin.variables.poll") },
        { name: "sleep", type: "function", desc: i18n.t("modelPlugin.variables.sleep") },
        { name: "signal", type: "AbortSignal", desc: i18n.t("modelPlugin.variables.signal") },
        { name: "onDelta", type: "function", desc: i18n.t("modelPlugin.variables.onDelta"), capabilities: ["text"] },
    ];
}

export function getPluginReturn(capability: ModelCapability) {
    return i18n.t(`modelPlugin.returns.${capability}`);
}

export function getPluginAuthoringPrompt(capability: ModelCapability, modelName: string, draft = "") {
    const variables = getPluginVariables().filter((variable) => !variable.capabilities || variable.capabilities.includes(capability));
    const lines = [
        i18n.t("modelPlugin.authoring.intro", { capability: i18n.t(`config.channelEditor.capabilities.${capability}`), model: modelName || i18n.t("modelPlugin.authoring.anyModel") }),
        "",
        i18n.t("modelPlugin.authoring.shape"),
        "",
        i18n.t("modelPlugin.authoring.returnTitle"),
        getPluginReturn(capability),
        "",
        i18n.t("modelPlugin.authoring.variablesTitle"),
        ...variables.map((variable) => `- ${variable.name} (${variable.type}): ${variable.desc}`),
        "",
        i18n.t("modelPlugin.authoring.rulesTitle"),
        i18n.t("modelPlugin.authoring.rules"),
    ];
    const templates = getPluginTemplates()[capability];
    if (templates.length) {
        lines.push("", i18n.t("modelPlugin.authoring.examplesTitle"));
        for (const template of templates) {
            lines.push("", `${template.label}`, template.script);
        }
    }
    if (draft.trim()) {
        lines.push("", i18n.t("modelPlugin.authoring.draftTitle"), draft.trim());
    }
    return lines.join("\n");
}

type PluginTemplate = { label: string; script: string };

export function getPluginTemplates(): Record<ModelCapability, PluginTemplate[]> {
    return {
        image: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI image generation and editing.
 * Text-to-image uses POST /v1/images/generations (JSON) when images is empty.
 * Image editing uses POST /v1/images/edits (multipart) when images has data URLs.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs; empty for text-to-image
 * @param {object} params
 * @param {string} params.size - output size, e.g. "1024x1024" or "auto"
 * @param {string} params.quality - "low" | "medium" | "high"
 * @param {number} params.count - number of images
 * @param {string} [params.background] - "transparent" when requested
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request - raw HTTP helper; relative urls join baseUrl without /v1
 * @returns {Promise<string[]>} image URLs or data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    quality,
    count,
    background,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  if (images.length === 0) {
    const data = await request({
      method: "post",
      url: \`\${baseUrl}/v1/images/generations\`,
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${apiKey}\`,
      },
      data: {
        model: model,
        prompt: prompt,
        n: count,
        size: size,
        quality: quality,
        background: background,
        response_format: "b64_json",
      },
    });
    const urls = [];
    for (const item of data.data || []) {
      urls.push(item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
    }
    return urls;
  }

  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("n", String(count));
  form.set("size", size);
  form.set("quality", quality);
  form.set("background", background);
  form.set("response_format", "b64_json");
  const imageField = images.length > 1 ? "image[]" : "image";
  for (const dataUrl of images) {
    form.append(imageField, await (await fetch(dataUrl)).blob(), "ref.png");
  }
  const edited = await request({
    method: "post",
    url: \`\${baseUrl}/v1/images/edits\`,
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: form,
  });
  const urls = [];
  for (const item of edited.data || []) {
    urls.push(item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini image generation via models/{model}:generateContent.
 * Reference images go into parts.inline_data. size maps to aspectRatio; quality maps to imageSize.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {object} params
 * @param {string} params.size - "1024x1024", "16:9", "auto", etc.; sent as aspectRatio
 * @param {string} params.quality - "low" | "medium" | "high"; sent as imageSize 1K/2K/4K
 * @param {number} params.count - number of generateContent calls
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<string[]>} image data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    quality,
    count,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  const parts = [{ text: prompt }];
  for (const dataUrl of images) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      parts.push({
        inline_data: {
          mime_type: match[1],
          data: match[2],
        },
      });
    }
  }

  const aspectRatioMap = {
    "1024x1024": "1:1",
    "1280x720": "16:9",
    "720x1280": "9:16",
    "1536x1024": "3:2",
    "1024x1536": "2:3",
  };
  const imageSizeMap = {
    low: "1K",
    medium: "2K",
    high: "4K",
  };
  let aspectRatio = "1:1";
  if (size && size !== "auto") {
    aspectRatio = aspectRatioMap[size] || size;
  }
  let imageSize = "1K";
  if (imageSizeMap[quality]) {
    imageSize = imageSizeMap[quality];
  }
  const n = Number(count) || 1;
  const urls = [];

  for (let i = 0; i < n; i++) {
    const data = await request({
      method: "post",
      url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      data: {
        contents: [
          {
            role: "user",
            parts: parts,
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: aspectRatio,
            imageSize: imageSize,
          },
        },
      },
    });
    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        const img = part.inlineData || part.inline_data;
        if (img && img.data) {
          urls.push(\`data:\${img.mimeType || img.mime_type || "image/png"};base64,\${img.data}\`);
        }
      }
    }
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
        ],
        video: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI-compatible video: POST /v1/videos (multipart), then poll GET /v1/videos/{id}.
 * Do not set Content-Type on FormData; the browser adds the boundary.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {File[]} videos - reference videos; empty when none
 * @param {File[]} audios - reference audio; empty when none
 * @param {object} params
 * @param {string} params.mode - "frames" uses first/last frame fields; "reference" sends all images as references. More than 2 images become "reference".
 * @param {string|number} params.seconds - duration
 * @param {string} params.size - output size, e.g. "1280x720"
 * @param {string} params.resolution - e.g. "720p"
 * @param {boolean} params.generateAudio
 * @param {boolean} params.watermark
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}|Blob>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    size,
    resolution,
    generateAudio,
    watermark,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("seconds", String(seconds || 8));
  form.set("size", String(size || "1280x720"));
  form.set("resolution_name", String(resolution || "720p"));
  form.set("generate_audio", String(generateAudio !== false));
  form.set("watermark", String(watermark === true));
  form.set("mode", mode);
  if (mode === "frames") {
    if (images[0]) {
      form.append("first_frame", await (await fetch(images[0])).blob(), "first.png");
    }
    if (images[1]) {
      form.append("last_frame", await (await fetch(images[1])).blob(), "last.png");
    }
  } else {
    for (const dataUrl of images) {
      form.append("image[]", await (await fetch(dataUrl)).blob(), "ref.png");
    }
  }
  for (const file of videos) {
    form.append("video[]", file);
  }
  for (const file of audios) {
    form.append("audio[]", file);
  }

  const headers = {
    Authorization: \`Bearer \${apiKey}\`,
  };
  const task = await request({
    method: "post",
    url: \`\${baseUrl}/v1/videos\`,
    headers,
    data: form,
  });

  return await poll(
    async () => {
      const state = await request({
        method: "get",
        url: \`\${baseUrl}/v1/videos/\${task.id}\`,
        headers,
      });
      if (state.status === "failed" || state.status === "cancelled") {
        throw new Error(state.error && state.error.message ? state.error.message : "video generation failed");
      }
      if (state.video_url || state.url) {
        return { url: state.video_url || state.url };
      }
      if (state.status === "completed") {
        return await request({
          method: "get",
          url: \`\${baseUrl}/v1/videos/\${task.id}/content\`,
          headers,
          responseType: "blob",
        });
      }
      return null;
    },
    (result) => result,
    { intervalMs: 2500, timeoutMs: 300000 },
  );
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini Veo video: POST models/{model}:predictLongRunning, then poll the operation.
 * First/last-frame mode: images[0] -> image, images[1] -> lastFrame.
 * Reference mode: all images -> referenceImages.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {File[]} videos - reference videos; empty when none
 * @param {File[]} audios - reference audio; empty when none
 * @param {object} params
 * @param {string} params.mode - "frames" or "reference"
 * @param {string|number} params.seconds - sent as durationSeconds
 * @param {string} params.size - pixel size; mapped to aspectRatio when needed
 * @param {string} params.ratio - aspect ratio, e.g. "16:9"
 * @param {string} params.resolution - e.g. "720p"
 * @param {boolean} params.generateAudio
 * @param {boolean} params.watermark - sent as addWatermark
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    size,
    resolution,
    ratio,
    generateAudio,
    watermark,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  async function toInline(source) {
    if (typeof source === "string") {
      const match = source.match(/^data:([^;]+);base64,(.*)$/);
      return {
        bytesBase64Encoded: match ? match[2] : "",
        mimeType: match ? match[1] : "image/png",
      };
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(source);
    });
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    return {
      bytesBase64Encoded: match ? match[2] : "",
      mimeType: match ? match[1] : (source.type || "application/octet-stream"),
    };
  }

  const aspectRatioMap = {
    "1280x720": "16:9",
    "1920x1080": "16:9",
    "720x1280": "9:16",
    "1080x1920": "9:16",
  };
  let aspectRatio = ratio || size || "16:9";
  if (aspectRatio === "auto") {
    aspectRatio = "16:9";
  }
  if (aspectRatioMap[aspectRatio]) {
    aspectRatio = aspectRatioMap[aspectRatio];
  }

  const instance = {
    prompt: prompt,
  };
  if (mode === "frames") {
    if (images[0]) {
      instance.image = await toInline(images[0]);
    }
    if (images[1]) {
      instance.lastFrame = await toInline(images[1]);
    }
  } else {
    instance.referenceImages = [];
    for (const dataUrl of images) {
      instance.referenceImages.push({
        image: await toInline(dataUrl),
        referenceType: "asset",
      });
    }
  }
  if (videos[0]) {
    instance.video = await toInline(videos[0]);
  }
  if (audios[0]) {
    instance.audio = await toInline(audios[0]);
  }

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
  const op = await request({
    method: "post",
    url: \`\${baseUrl}/v1beta/models/\${model}:predictLongRunning\`,
    headers,
    data: {
      instances: [instance],
      parameters: {
        aspectRatio: aspectRatio,
        durationSeconds: Number(seconds) || 8,
        resolution: resolution || "720p",
        generateAudio: generateAudio !== false,
        addWatermark: watermark === true,
      },
    },
  });

  return await poll(
    () => request({
      method: "get",
      url: \`\${baseUrl}/v1beta/\${op.name}\`,
      headers,
    }),
    (state) => {
      if (state.error) {
        throw new Error(state.error.message || "video generation failed");
      }
      if (!state.done) return null;
      const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error("Gemini did not return a video URI");
      if (uri.includes("key=")) return { url: uri };
      const separator = uri.includes("?") ? "&" : "?";
      return { url: uri + separator + "key=" + apiKey };
    },
    { intervalMs: 5000, timeoutMs: 300000 },
  );
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`,
            },
        ],
        audio: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI speech: POST /v1/audio/speech.
 * @param {string} prompt - text to speak
 * @param {object} params
 * @param {string} params.voice
 * @param {string} params.format - response_format, e.g. "mp3"
 * @param {string|number} params.speed
 * @param {string} [params.instructions] - voice style instructions
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<Blob>}
 */
async function generateAudio({
  prompt,
  params: {
    voice,
    format,
    speed,
    instructions,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  return await request({
    method: "post",
    url: \`\${baseUrl}/v1/audio/speech\`,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    responseType: "blob",
    data: {
      model: model,
      input: prompt,
      voice: voice,
      response_format: format,
      speed: Number(speed),
      instructions: instructions,
    },
  });
}

return await generateAudio({
  prompt,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini TTS: POST models/{model}:generateContent with AUDIO modality.
 * Audio bytes are returned in inlineData.data (base64 PCM).
 * @param {string} prompt - text to speak
 * @param {object} params
 * @param {string} params.voice - prebuilt voice name
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<{data: string}>}
 */
async function generateAudio({
  prompt,
  params: {
    voice,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    data: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    },
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  let audio = null;
  for (const part of parts) {
    audio = part.inlineData || part.inline_data;
    if (audio && audio.data) break;
  }
  if (!audio || !audio.data) throw new Error("Gemini did not return audio");
  return { data: audio.data };
}

return await generateAudio({
  prompt,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
        ],
        text: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI text: POST /v1/responses.
 * @param {{role: string, content: string}[]} messages - includes the system message when present
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} reasoningEffort - "auto" | "low" | "medium" | "high" | "xhigh"; omit reasoning when "auto"
 * @param {function} request
 * @param {function} onDelta - push streaming text
 * @returns {Promise<string>}
 */
async function generateText({
  messages,
  model,
  baseUrl,
  apiKey,
  reasoningEffort,
  request,
  onDelta,
}) {
  const body = {
    model: model,
    input: messages,
  };
  if (reasoningEffort && reasoningEffort !== "auto") {
    body.reasoning = {
      effort: reasoningEffort,
    };
  }
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1/responses\`,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: body,
  });
  const text = data.output_text
    || (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || "").join("")
    || "";
  onDelta(text);
  return text;
}

return await generateText({
  messages,
  model,
  baseUrl,
  apiKey,
  reasoningEffort,
  request,
  onDelta,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini text: POST models/{model}:generateContent.
 * System messages are skipped in contents; systemPrompt goes to systemInstruction.
 * @param {{role: string, content: string}[]} messages
 * @param {string} systemPrompt
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} onDelta - push streaming text
 * @returns {Promise<string>}
 */
async function generateText({
  messages,
  systemPrompt,
  model,
  baseUrl,
  apiKey,
  request,
  onDelta,
}) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }
  const body = {
    contents: contents,
  };
  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    data: body,
  });
  let text = "";
  for (const part of data.candidates?.[0]?.content?.parts || []) {
    text += part.text || "";
  }
  onDelta(text);
  return text;
}

return await generateText({
  messages,
  systemPrompt,
  model,
  baseUrl,
  apiKey,
  request,
  onDelta,
});`,
            },
        ],
    };
}

/** Normalize whatever an image script returns into the app's generated-image shape. */
export function normalizePluginImages(result: unknown): string[] {
    const items = Array.isArray(result) ? result : [result];
    const urls = items
        .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
                const record = item as Record<string, unknown>;
                if (typeof record.dataUrl === "string") return record.dataUrl;
                if (typeof record.url === "string" && record.url.startsWith("data:")) return record.url;
                if (typeof record.b64_json === "string") return `data:image/png;base64,${record.b64_json}`;
            }
            return "";
        })
        .filter(Boolean);
    if (!urls.length) throw new Error(i18n.t("modelPlugin.noImages"));
    return urls;
}
