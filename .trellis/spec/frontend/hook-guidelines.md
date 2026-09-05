# Hook Guidelines

> Custom hook and data-fetching patterns currently used by `web`.

## Naming and Placement

Custom hooks use the `use*` name and are exported from `web/src/hooks/` when shared. Examples include `usePromptSourceScheduler` in `web/src/hooks/use-prompt-source-scheduler.ts` and `useCopyText` in `web/src/hooks/use-copy-text.ts`. A hook used by one page should remain in that page's directory.

Hooks should contain stateful behavior or effects, not become a second service layer. Shared Zustand stores are read directly inside the hook or component when that is the existing ownership boundary.

## Data Fetching

Service modules own request and response behavior; React Query owns cache state in components that need server-like asynchronous data. `web/src/components/layout/config-prompt-sources.tsx` calls `useQuery({ queryKey, queryFn })` with `fetchPromptSourceStatuses` from `web/src/services/api/prompts.ts`. `web/src/components/canvas/canvas-side-panel.tsx` uses a query for source prompts and enables it only when results are visible.

Use stable query keys and invalidate related keys after a write. The prompt-source configuration component invalidates `prompts`, `side-panel-prompts`, and `prompt-source-statuses` after a refresh or source change. The shared `QueryClient` defaults in `web/src/components/layout/app-providers.tsx` currently use a 30-second stale time, no retries, and no refetch on window focus; follow those defaults unless the feature has a concrete reason to differ.

## Effects and Cleanup

Use `useEffect` for subscriptions, timers, and DOM effects, and return cleanup functions. `usePromptSourceScheduler` prevents overlapping refresh cycles with a local `running` guard and clears its interval on unmount. Avoid starting asynchronous work without handling its lifecycle; the scheduler deliberately catches per-cycle failures because source state records them for the next cycle.

## UI Side Effects

Repeated UI effects such as copying text and showing a notification belong in shared hooks when they are reused. Do not put transient notification or clipboard behavior into a Zustand store. `useCopyText` is the existing example; feature-specific loading flags and messages may remain in the owning component, as in `config-local-proxy.tsx`.

## Common Mistakes

- Do not fetch directly in every render or use a new query key shape for an existing resource; follow the query ownership in `web/src/components/layout/config-prompt-sources.tsx` and `web/src/components/canvas/canvas-side-panel.tsx`.
- Do not duplicate cache invalidation lists without checking the owning query consumers; `web/src/components/layout/config-prompt-sources.tsx` is the current invalidation example.
- Do not omit effect cleanup for intervals, event listeners, or subscriptions; `web/src/hooks/use-prompt-source-scheduler.ts` clears its interval on unmount.
- Do not turn a simple synchronous formatter into a hook just because it is used in a component; shared hook examples live in `web/src/hooks/use-copy-text.ts`.
