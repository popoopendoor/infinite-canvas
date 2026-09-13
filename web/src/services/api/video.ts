import i18n from "@/i18n";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { fetchModelTask, submitModelTask, taskOutput } from "./model-task";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type RequestOptions = { signal?: AbortSignal };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob: Blob };
export type VideoGenerationTask = {
    id: string;
    provider: "bff" | "plugin";
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(await createVideoGenerationTask(config, prompt, references, options), options);
}

export async function waitForVideoGenerationTask(task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw videoTaskFailed(state.error);
        if (attempt === 119) throw new Error(apiText("videoTimeout", { provider: "" }));
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    const imageReferences = await Promise.all(references.map(async (image) => ({ dataUrl: await imageToDataUrl(image, options), mimeType: image.type || undefined })));
    const mediaReferences = await Promise.all([
        ...imageReferences,
        ...(options?.videos || []).map(async (video) => ({ dataUrl: await readFileAsDataUrl(await referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)), mimeType: video.type || "video/mp4" })),
        ...(options?.audios || []).map(async (audio) => ({ dataUrl: await readFileAsDataUrl(await referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)), mimeType: audio.type || "audio/mpeg" })),
    ]);
    const params = {
        seconds: normalizeVideoSeconds(config.videoSeconds),
        size: normalizeVideoSize(config.size, config.vquality),
        resolution: normalizeVideoResolution(config.vquality),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
        mode: resolveVideoMode(config.videoMode, references.length),
    };
    const script = resolveModelScript(config, selectedModel);
    if (script) {
        let taskId = "";
        const pluginParams = { ...params, generateAudio: params.generate_audio };
        await runModelPlugin({
            config: requestConfig,
            capability: "video",
            script,
            prompt,
            images: imageReferences.map((reference) => reference.dataUrl),
            videos: await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options))),
            audios: await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options))),
            params: pluginParams,
            signal: options?.signal,
            onTask: (task) => {
                taskId = task.id;
            },
        });
        if (!taskId) throw new Error(apiText("noVideoTaskId"));
        return { id: taskId, provider: "plugin" };
    }
    const task = await submitModelTask({
        config: requestConfig,
        capability: "video",
        prompt,
        params,
        references: mediaReferences,
        signal: options?.signal,
    });
    return { id: task.id, provider: "bff" };
}

export async function pollVideoGenerationTask(task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider !== "bff" && task.provider !== "plugin") return { status: "failed", error: apiText("videoGenerationFailed") };
    const record = await fetchModelTask(task.id, options?.signal);
    if (record.status === "pending_reconciliation" || record.status === "created" || record.status === "held" || record.status === "running") return { status: "pending" };
    if (record.status === "failed") return { status: "failed", error: record.errorMessage || apiText("videoGenerationFailed") };
    const output = taskOutput(record);
    if (task.provider === "bff") {
        const result = binaryVideoResult(output);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("noPlayableVideo") };
    }
    try {
        return { status: "completed", result: pluginVideoResult(output) };
    } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : apiText("noPlayableVideo") };
    }
}

function pluginVideoResult(value: unknown): VideoGenerationResult {
    if (typeof value === "string") return dataUrlVideoResult(value);
    if (value && typeof value === "object") {
        const record = value as { dataUrl?: unknown; url?: unknown };
        if (typeof record.dataUrl === "string") return dataUrlVideoResult(record.dataUrl);
        if (typeof record.url === "string") return dataUrlVideoResult(record.url);
    }
    const result = binaryVideoResult(value);
    if (result) return result;
    throw new Error(apiText("scriptNoVideo"));
}

function dataUrlVideoResult(value: string): VideoGenerationResult {
    const match = value.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error(apiText("scriptNoVideo"));
    const result = binaryVideoResult({ kind: "binary", contentType: match[1] || "video/mp4", base64: match[2] });
    if (!result) throw new Error(apiText("scriptNoVideo"));
    return result;
}

function binaryVideoResult(value: unknown): VideoGenerationResult | undefined {
    if (!isBinaryOutput(value)) return undefined;
    const binary = atob(value.base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return { blob: new Blob([bytes], { type: value.contentType || "video/mp4" }) };
}

function isBinaryOutput(value: unknown): value is { kind: "binary"; base64: string; contentType: string } {
    return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "binary" && typeof (value as { base64?: unknown }).base64 === "string" && typeof (value as { contentType?: unknown }).contentType === "string");
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    return uploadMediaFile(result.blob, "video");
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
}

async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(apiText(errorKey));
        }
    }
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

function normalizeVideoSeconds(value: string) {
    return clampVideoSeconds(value);
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function normalizeVideoSize(value: string, resolution?: string) {
    if (value === "auto") return null;
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value || "16:9");
    if (ratio === "auto") return null;
    return computeVideoSize(resolution || "720", ratio);
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function delay(ms: number, signal?: AbortSignal) {
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
