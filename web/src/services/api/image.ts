import i18n from "@/i18n";
import { resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { submitModelTask, taskOutput } from "./model-task";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { readRequestError } from "./api-error";
import { nanoid } from "nanoid";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withSystemMessage(config: AiConfig, messages: AiTextMessage[]) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const params = { count: n, ...(quality ? { quality } : {}), ...(requestSize ? { size: requestSize } : {}), ...(background ? { background } : {}), outputFormat: IMAGE_OUTPUT_FORMAT };
    try {
        const script = resolveModelScript(config, config.model || config.imageModel);
        if (script) return pluginImages(requestConfig, script, withSystemPrompt(requestConfig, prompt), params, [], options);
        return bffImages(requestConfig, withSystemPrompt(requestConfig, prompt), params, [], options);
    } catch (error) {
        throw new Error(readRequestError(error, apiText("requestFailed")));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    try {
        const refs = await Promise.all(references.map(async (image) => ({ dataUrl: await imageToDataUrl(image, options), mimeType: image.type || undefined })));
        const params = { count: n, ...(quality ? { quality } : {}), ...(requestSize ? { size: requestSize } : {}), ...(background ? { background } : {}), outputFormat: IMAGE_OUTPUT_FORMAT };
        const script = resolveModelScript(config, config.model || config.imageModel);
        if (script) return pluginImages(requestConfig, script, withSystemPrompt(requestConfig, requestPrompt), params, refs, options);
        return bffImages(requestConfig, withSystemPrompt(requestConfig, requestPrompt), params, refs, options);
    } catch (error) {
        throw new Error(readRequestError(error, apiText("requestFailed")));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        const script = resolveModelScript(config, config.model || config.textModel);
        if (script) {
            const answer = await runModelPlugin<unknown>({
                config: requestConfig,
                capability: "text",
                script,
                messages: withSystemMessage(requestConfig, messages),
                params: requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } },
                signal: options?.signal,
                onDelta,
            });
            if (typeof answer !== "string") throw new Error(apiText("noContent"));
            return answer;
        }
        const task = await submitModelTask({
            config: requestConfig,
            capability: "text",
            messages: withSystemMessage(requestConfig, messages),
            params: requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } },
            signal: options?.signal,
        });
        const output = taskOutput(task);
        const answer = output && typeof output === "object" && (output as { kind?: unknown }).kind === "text" && typeof (output as { text?: unknown }).text === "string" ? (output as { text: string }).text : apiText("noContent");
        onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readRequestError(error, apiText("requestFailed")));
    }
}

async function pluginImages(config: AiConfig, script: string, prompt: string, params: Record<string, unknown>, references: Array<{ dataUrl: string }>, options?: RequestOptions) {
    const result = await runModelPlugin({ config, capability: "image", script, prompt, images: references.map((reference) => reference.dataUrl), params, signal: options?.signal });
    return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
}

async function bffImages(config: AiConfig, prompt: string, params: Record<string, unknown>, references: Array<{ dataUrl: string; mimeType?: string }>, options?: RequestOptions) {
    const task = await submitModelTask({ config, capability: "image", prompt, params, references, signal: options?.signal });
    const output = taskOutput(task);
    const items = output && typeof output === "object" && (output as { kind?: unknown }).kind === "images" ? (output as { items?: unknown }).items : null;
    if (!Array.isArray(items)) throw new Error(apiText("noImageReturned"));
    const images = items
        .map((item) => (item && typeof item === "object" ? (item as { dataUrl?: unknown }).dataUrl : ""))
        .filter((source): source is string => typeof source === "string" && source.startsWith("data:"))
        .map((dataUrl) => ({ id: nanoid(), dataUrl }));
    if (!images.length) throw new Error(apiText("noImageReturned"));
    return images;
}
