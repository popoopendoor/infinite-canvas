# Type Safety

> TypeScript and runtime-boundary conventions evidenced by `web` and `canvas-agent`.

## Compiler Configuration

`web/tsconfig.json` enables `strict`, `noEmit`, `isolatedModules`, bundler module resolution, and the `@/*` path alias. Keep production code type-safe under these settings; do not weaken `strict` or introduce a second module-resolution convention to make one import work.

The frontend package is TypeScript-first, as shown by the strict compiler settings in `web/tsconfig.json` and the TypeScript source under `web/src/`. Keep exported domain and API contracts explicit, and infer local values from typed data where that keeps code readable.

## Type Organization
Define a type beside the module that owns the contract when it is local to that boundary. `web/src/services/api/canvas-agent.ts` defines `AgentSkill*` and response types for the agent API; `web/src/stores/use-asset-store.ts` defines the `Asset` discriminated union; shared canvas contracts live in `web/src/types/canvas.ts`; configuration contracts live in `web/src/stores/use-config-store.ts`.

Use discriminated unions for finite domain variants. `web/src/stores/use-asset-store.ts` discriminates `Asset` on `kind`, while `web/src/types/canvas.ts` and `canvas-agent/src/canvas/schemas.ts` use explicit type strings. Prefer `type` aliases for data shapes and function signatures, matching these modules.

## API and Runtime Boundaries

Type network responses at the service boundary and translate failures into a typed error when callers need status information. `AgentApiError` in `web/src/services/api/canvas-agent.ts` retains the HTTP status and response fields; `fetchAgentJson` parses a JSON response and throws it for non-OK statuses.

Do not treat external JSON as trusted merely because it has a TypeScript cast. Narrow unknown values before using them, and keep normalization close to the service/store that reads the data. The backend's runtime validation uses Zod in `canvas-agent/src/canvas/schemas.ts`; no separate frontend Zod validation layer is currently established, so do not add one by convention alone.

## Safe Patterns

Use `unknown` for caught or external values and narrow with `instanceof`, `typeof`, `Array.isArray`, or a domain predicate. Existing code handles user-facing async errors as `error instanceof Error ? error.message : fallback` in `web/src/components/layout/app-config-modal.tsx` and normalizes persisted values while merging defaults in `web/src/stores/use-config-store.ts` and `web/src/stores/use-prompt-source-store.ts`.

Avoid broad `any` types in production contracts and avoid assertions that bypass a boundary without a runtime check. Some existing tests use narrow casts for deliberately constructed fakes; do not copy that test-only shortcut into service or UI code.
