import i18n from "@/i18n";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { submitModelTask, taskOutput } from "./model-task";
import { runModelPlugin } from "./model-plugin";
import { readRequestError } from "./api-error";

type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    const instructions = config.audioInstructions.trim();
    const params = { voice: normalizeAudioVoiceValue(config.audioVoice), response_format: format, speed: Number(normalizeAudioSpeedValue(config.audioSpeed)), ...(instructions ? { instructions } : {}) };

    try {
        const script = resolveModelScript(config, config.model || config.audioModel);
        if (script) {
            const pluginParams = { ...params, format };
            return pluginAudio(await runModelPlugin({ config: { ...requestConfig, model }, capability: "audio", script, prompt, params: pluginParams, signal: options?.signal }), audioMimeType(format));
        }
        const task = await submitModelTask({
            config: { ...requestConfig, model },
            capability: "audio",
            prompt,
            params,
            signal: options?.signal,
        });
        const output = taskOutput(task);
        if (!output || typeof output !== "object" || (output as { kind?: unknown }).kind !== "binary" || typeof (output as { base64?: unknown }).base64 !== "string") {
            throw new Error(apiText("audioGenerationFailed"));
        }
        return binaryBlob((output as { base64: string }).base64, (output as { contentType?: unknown }).contentType, audioMimeType(format));
    } catch (error) {
        throw new Error(readRequestError(error, apiText("audioGenerationFailed")));
    }
}

async function pluginAudio(value: unknown, fallback: string): Promise<Blob> {
    if (value instanceof Blob) return value;
    if (typeof value === "string") return dataUrlBlob(value, fallback);
    if (value && typeof value === "object") {
        const record = value as { base64?: unknown; b64_json?: unknown; data?: unknown; dataUrl?: unknown; url?: unknown; contentType?: unknown };
        const base64 = [record.base64, record.b64_json, record.data].find((item): item is string => typeof item === "string");
        if (base64) return binaryBlob(base64.replace(/^data:[^;]+;base64,/, ""), record.contentType, fallback);
        if (typeof record.dataUrl === "string") return dataUrlBlob(record.dataUrl, fallback);
        if (typeof record.url === "string") return dataUrlBlob(record.url, fallback);
    }
    throw new Error(apiText("scriptNoAudio"));
}

function dataUrlBlob(value: string, fallback: string) {
    const match = value.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error(apiText("scriptNoAudio"));
    return binaryBlob(match[2], match[1], fallback);
}

function binaryBlob(base64: string, contentType: unknown, fallback: string) {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: typeof contentType === "string" && contentType.startsWith("audio/") ? contentType : fallback });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}
