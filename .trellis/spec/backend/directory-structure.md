# Backend Directory Structure

> Current backend layout for the `canvas-agent` package.

## Overview

`canvas-agent` is a small TypeScript Node package. Its entry point, `canvas-agent/src/index.ts`, starts either the local Express HTTP server in `canvas-agent/src/server/http.ts` or the MCP stdio server in `canvas-agent/src/server/mcp.ts`. Domain code is grouped by the capability it owns; there is no separate `routes/`, `controllers/`, or `services/` layer in the current package.

## Directory Layout

```text
canvas-agent/
├── canvas-agent/src/index.ts                 # process entry point
├── canvas-agent/src/server/http.ts           # Express app, middleware, HTTP routes
├── canvas-agent/src/server/mcp.ts            # MCP server and tool registration
├── canvas-agent/src/agent/                   # Codex/Claude clients, protocol, history
├── canvas-agent/src/canvas/                  # canvas session, operations, schemas
├── canvas-agent/src/skills/                  # skill store and skill validation
├── canvas-agent/src/utils/                   # cross-cutting utilities such as logging
└── canvas-agent/src/*.test.ts                # unit tests beside the module they cover
```

Examples are `canvas-agent/src/server/http.ts`, `canvas-agent/src/server/mcp.ts`, `canvas-agent/src/canvas/operations.ts`, and `canvas-agent/src/skills/store.ts`.

## Module Organization

- Keep process bootstrapping in `canvas-agent/src/index.ts`. It only selects `startMcpServer()` or `startHttpServer()` based on the command argument.
- Define Express middleware and HTTP endpoints directly in `canvas-agent/src/server/http.ts`. The file currently owns CORS, token authorization, response envelopes, and the terminal error handlers.
- Define MCP tool registration and the HTTP forwarding adapter in `canvas-agent/src/server/mcp.ts`. Tool names and Zod input schemas belong to `canvas-agent/src/canvas/schemas.ts`.
- Keep capability-specific behavior with its domain: Codex behavior is under `canvas-agent/src/agent/`, canvas transformation is under `canvas-agent/src/canvas/`, and skill persistence/validation is under `canvas-agent/src/skills/`.
- Put reusable cross-cutting code in `canvas-agent/src/utils/` only when it is genuinely shared. The logger in `canvas-agent/src/utils/logger.ts` is the current example.
- Add tests beside the module under test using the same basename with `.test.ts`, as in `canvas-agent/src/config.test.ts`, `canvas-agent/src/canvas/operations.test.ts`, and `canvas-agent/src/skills/store.test.ts`.

Do not create a generic service or controller directory just to move a small function out of its owning module; the current HTTP boundary remains in `canvas-agent/src/server/http.ts`.


## Naming

Use kebab-case file names such as `canvas-agent/src/agent/codex-client.ts`, `canvas-agent/src/agent/message-metadata.ts`, and `canvas-agent/src/utils/agent-runtime.test.ts`. Use PascalCase for classes (`Logger` in `canvas-agent/src/utils/logger.ts`, `SkillStore` in `canvas-agent/src/skills/store.ts`), camelCase for functions and values, and explicit TypeScript types for exported contracts.

## Route Example

```ts
app.get("/agent/codex/models", route(async (_req, res) =>
    res.json({ ok: true, ...(await listCodexModels(emit)) }),
));
```

The route is declared in `canvas-agent/src/server/http.ts`; its domain operation remains in `src/agent/codex.ts`.
