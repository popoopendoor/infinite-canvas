# Error Handling

> How the current `canvas-agent` HTTP and MCP layers handle errors.

## Overview

Errors are handled at the boundary where they can be translated into a useful response. Async Express handlers are wrapped so rejected promises reach one terminal middleware. The route wrapper and terminal middleware are both defined in `canvas-agent/src/server/http.ts`. Domain errors that carry an HTTP status retain that status; unknown errors become a `500` response.

## Express Async Handlers

Use the local `route()` helper in `canvas-agent/src/server/http.ts` for async handlers:

```ts
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}
```

Existing examples include `GET /agent/attachments/:attachmentId`, Codex model/skill routes, and Codex mutation routes. Synchronous handlers send their response directly. When a handler has cleanup to perform, preserve the primary error and log cleanup failures separately, as the Codex turn handler does.

## Domain Errors

Use a typed error only when the caller needs a deliberate status code. `SkillStoreError` in `canvas-agent/src/skills/store.ts` and `CodexSkillLookupError` in `canvas-agent/src/agent/codex.ts` expose `statusCode` values used by the HTTP middleware. Do not add a broad hierarchy for ordinary failures.

At the MCP boundary, validate tool input with the schema owned by `canvas-agent/src/canvas/schemas.ts`; `canvas-agent/src/server/mcp.ts` calls `schema.parse(input)` before forwarding the request. Invalid input should fail at this boundary rather than being passed as an unchecked object.

## Response Format

HTTP errors use a JSON envelope with `ok: false` and an `error` message in `canvas-agent/src/server/http.ts`. Some concurrency and state errors add a stable `code` and a `state` snapshot, for example `CONVERSATION_STALE`, `CONVERSATION_NOT_READY`, and `CONVERSATION_BUSY` in that same file.

The server in `canvas-agent/src/server/http.ts` also returns `{ ok: false, error: "not found" }` for unmatched routes and `{ ok: false, error: "invalid token" }` for failed authorization. Preserve the status code and envelope when adding endpoints so the frontend can handle failures consistently.

```ts
app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));

app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error("HTTP request failed", { method: req.method, path: req.path, error });
    if (error instanceof SkillStoreError || error instanceof CodexSkillLookupError) {
        return void res.status(error.statusCode).json({ ok: false, error: error.message });
    }
    res.status(500).json({ ok: false, error: error.message });
});
```

Do not return stack traces or raw request bodies to clients. Keep user-facing messages meaningful and avoid leaking credentials or data URLs.
