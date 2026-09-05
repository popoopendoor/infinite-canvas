# Backend Quality Guidelines

> Quality practices evidenced by the `canvas-agent` package.

## TypeScript and Build

The backend uses strict TypeScript with NodeNext modules. `canvas-agent/tsconfig.json` enables `strict`, declarations, and `noImplicit` behavior through strict mode; it excludes `src/**/*.test.ts` from the production build. The package build command is `npm run build` (`tsc -p tsconfig.json`). There is no backend lint script in `canvas-agent/package.json`, so do not report a lint command that does not exist.

## Testing

Use Node's built-in test runner through `tsx --test`; do not add a test framework just to follow a template. The package test script lists the existing co-located test files. Tests import `test` from `node:test` and assertions from `node:assert/strict`.

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
});
```

Relevant examples are `canvas-agent/src/canvas/operations.test.ts`, `canvas-agent/src/config.test.ts`, `canvas-agent/src/skills/store.test.ts`, and `canvas-agent/src/agent/codex-client.test.ts`. Prefer deterministic fakes and assertions about observable behavior, status, and protocol messages over live external services.

## Review Checklist

For backend changes, check that:

- new HTTP routes remain in `canvas-agent/src/server/http.ts`, are placed after CORS and token middleware when protected, and use `route()` for async failures;
- success and error response envelopes in `canvas-agent/src/server/http.ts` preserve `ok`, status, and any established `code`/`state` contract;
- external or untrusted MCP tool input is validated by the Zod schemas in `canvas-agent/src/canvas/schemas.ts` before registration in `canvas-agent/src/server/mcp.ts`;
- logs use the shared logger from `canvas-agent/src/utils/logger.ts` and the HTTP/Codex logging points in `canvas-agent/src/server/http.ts` do not expose tokens, API keys, data URLs, prompt contents, or large payloads;
- focused behavior tests cover new branches, using the co-located tests listed by `canvas-agent/package.json`, and `npm test` plus `npm run build` are run when the change affects `canvas-agent`.

Keep changes scoped to the owning package. `canvas-agent/package.json` lists the package's available test/build commands, and the co-located tests such as `canvas-agent/src/config.test.ts` are the evidence for its current test boundary. There is no evidence for a backend integration-test harness or mandatory coverage threshold; do not invent one in a feature task.
