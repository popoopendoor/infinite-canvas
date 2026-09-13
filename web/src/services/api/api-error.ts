import i18n from "@/i18n";

export function readRequestError(error: unknown, fallback: string) {
    if (error instanceof DOMException && error.name === "AbortError") return i18n.t("apiErrors.requestCanceled");
    return error instanceof Error && error.message ? error.message : fallback;
}
