import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../errors.js";

export const capabilitySchema = z.enum(["image", "video", "text", "audio"]);
export type Capability = z.infer<typeof capabilitySchema>;

const catalogBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "baseUrl must be an HTTP(S) URL without credentials, query parameters, or fragments");

const catalogEntrySchema = z.object({
  id: z.string().trim().min(1).max(120),
  capability: capabilitySchema,
  provider: z.enum(["openai", "gemini", "generic"]),
  baseUrl: catalogBaseUrlSchema,
  model: z.string().trim().min(1).max(200).optional(),
  priceVersion: z.string().trim().min(1).max(80),
  price: z.number().int().nonnegative().safe(),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export function providerModel(entry: CatalogEntry) {
  return entry.model || entry.id;
}

export type ModelRequest = {
  modelId: string;
  capability: Capability;
  prompt?: string;
  messages?: unknown[];
  params: Record<string, unknown>;
  references: Array<{ dataUrl: string; mimeType?: string }>;
  idempotencyKey: string;
  apiKeyEnvelope?: string;
};

export function loadCatalog(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_CATALOG_JSON must be valid JSON");
  }
  const result = z.array(catalogEntrySchema).parse(parsed);
  const ids = new Set<string>();
  for (const entry of result) {
    if (ids.has(entry.id))
      throw new Error(`Duplicate model catalog id: ${entry.id}`);
    ids.add(entry.id);
  }
  return result;
}

export function findModel(
  catalog: CatalogEntry[],
  modelId: string,
  capability: Capability,
) {
  const entry = catalog.find((item) => item.id === modelId);
  if (!entry) throw new HttpError(400, "bad_request", "Model is not published");
  if (entry.capability !== capability)
    throw new HttpError(
      400,
      "bad_request",
      "Model capability does not match request",
    );
  return entry;
}

export function normalizeQuote(input: unknown) {
  return z
    .object({
      modelId: z.string().trim().min(1).max(120),
      capability: capabilitySchema,
      params: z.record(z.unknown()).default({}),
    })
    .parse(input);
}

export function normalizeRequest(input: unknown): ModelRequest {
  return validateRequest(requestSchema.parse(input));
}

export function normalizeCustomRequest(input: unknown) {
  return validateRequest(
    requestSchema
      .extend({ scriptHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(input),
  );
}

const requestSchema = z.object({
  modelId: z.string().trim().min(1).max(120),
  capability: capabilitySchema,
  prompt: z.string().max(200_000).optional(),
  messages: z.array(z.unknown()).max(200).optional(),
  params: z.record(z.unknown()).default({}),
  references: z
    .array(
      z.object({
        dataUrl: z.string().max(40_000_000),
        mimeType: z.string().max(120).optional(),
      }),
    )
    .max(9)
    .default([]),
  idempotencyKey: z.string().trim().min(8).max(200),
  apiKeyEnvelope: z.string().max(20_000).optional(),
});

function validateRequest<T extends ModelRequest>(value: T): T {
  if (!value.prompt && !value.messages?.length)
    throw new HttpError(
      400,
      "bad_request",
      "A prompt or messages are required",
    );
  return value;
}

export function requestHash(request: ModelRequest, entry: CatalogEntry) {
  const normalized = JSON.stringify({
    modelId: entry.id,
    capability: entry.capability,
    priceVersion: entry.priceVersion,
    prompt: request.prompt || "",
    messages: sortValue(request.messages || []),
    params: sortValue(request.params),
    references: request.references.map((reference) => ({
      dataUrl: reference.dataUrl,
      mimeType: reference.mimeType || "",
    })),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}
