export type ModelCapability = "image" | "video" | "text" | "audio";

export type PublishedModel = {
    id: string;
    capability: ModelCapability;
    provider: "openai" | "gemini" | "generic";
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    model?: string;
    priceVersion: string;
    price: number;
    credentialMode: "managed" | "byok";
};
