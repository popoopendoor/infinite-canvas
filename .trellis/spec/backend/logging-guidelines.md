# Logging Guidelines

> Logging conventions currently implemented by `canvas-agent/src/utils/logger.ts`.

## Logger and Output

Use the exported `logger` from `canvas-agent/src/utils/logger.ts` (`debug`, `info`, `warn`, and `error`) instead of creating another logger in a feature module. Winston writes a timestamped, single-line console format. Normal mode logs at `info` and above. Passing `--debug` enables `debug` output and also writes a daily file under `~/.infinite-canvas/logs/`.

```ts
logger.info("Codex turn accepted", {
    threadId,
    model: model || "default",
    promptLength: prompt.length,
    attachmentCount: attachments.length,
});
```

The HTTP middleware in `canvas-agent/src/server/http.ts` uses `debug` for selected request completion records, `info` for Codex lifecycle events, `warn` for recoverable cleanup failures, and `error` in the terminal request handler.

## Levels

- `debug`: diagnostic request/lifecycle details that are useful with `--debug`.
- `info`: significant operational events such as agent startup and accepted/started/finished Codex turns.
- `warn`: a non-fatal cleanup or recovery problem where the main operation can continue.
- `error`: a failed HTTP request or operation that needs investigation.

Do not add a new level or a separate logging format for a single module.

## Sanitization

`Logger` sanitizes metadata before passing it to Winston. Keys matching `token`, `authorization`, `apiKey`, or `dataUrl` become `[REDACTED]`; data URL values are summarized by length; `Error` values are reduced to name/message/stack; circular objects are marked `[CIRCULAR]`.

Even with this sanitizer, avoid passing secrets or large payloads to logs. Follow the existing Codex turn pattern and log `promptLength` and `attachmentCount`, not the prompt or image data itself. In `canvas-agent/src/config.ts`, the token is used for local authorization but should never be logged as a value.

## Examples

- `canvas-agent/src/utils/logger.ts`: Winston setup, levels, formatting, and sanitization.
- `canvas-agent/src/server/http.ts`: HTTP completion and error logging plus Codex lifecycle records.
- `canvas-agent/src/config.ts`: local token/config handling that must remain out of log payloads.
