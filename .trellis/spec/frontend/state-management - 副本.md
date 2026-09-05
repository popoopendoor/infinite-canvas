# State Management

> State ownership patterns currently used by the `web` application.

## State Categories

- Component-only interaction state uses React `useState`, such as selected tabs, active drawers, loading flags, and the currently viewed source in `web/src/components/layout/app-config-modal.tsx` and `web/src/components/layout/config-prompt-sources.tsx`.
- Cross-page or durable application state uses Zustand stores under `web/src/stores/`. Configuration is in `web/src/stores/use-config-store.ts`, assets in `web/src/stores/use-asset-store.ts`, prompt sources in `web/src/stores/use-prompt-source-store.ts`, and canvas projects in `web/src/stores/canvas/use-canvas-store.ts`.
- Server-like asynchronous/cache state uses TanStack Query. `web/src/components/layout/app-providers.tsx` creates the shared `QueryClient`; prompt-source status and side-panel prompts use query keys and invalidation in `web/src/components/layout/config-prompt-sources.tsx` and `web/src/components/canvas/canvas-side-panel.tsx`.
- URL/navigation state belongs to React Router. Routes are declared centrally in `web/src/router.tsx`.

## Zustand Patterns

Create typed stores with `create`, and use `persist` when the state must survive reloads. `web/src/stores/use-prompt-source-store.ts` is the current persisted store example. Select only the needed state or action in a component:

```tsx
const sources = usePromptSourceStore((state) => state.sources);
const updateSchedule = usePromptSourceStore((state) => state.updateSchedule);
```

The current stores expose domain actions such as `addSource`, `saveSource`, and `toggleSource` in `web/src/stores/use-prompt-source-store.ts`, `addAsset` in `web/src/stores/use-asset-store.ts`, and `updateProject` in `web/src/stores/canvas/use-canvas-store.ts`; components call these actions instead of mutating arrays directly. Derived normalization and persistence merge behavior stays in the store that owns the data.

## Persistence

Use `localforage` through `web/src/lib/localforage-storage.ts` for large business data such as assets and canvas projects. `use-asset-store.ts` and `stores/canvas/use-canvas-store.ts` provide custom persisted storage for media resolution and debounced canvas writes. The app's current configuration and prompt-source stores use Zustand persistence with their existing storage behavior, while tiny UI values such as `canvas-side-panel-width` use `localStorage` directly.

The application is currently local-first. Do not describe these stores as cloud-synchronized; WebDAV synchronization is an explicit feature path, not the default store backend.

## Server State and Updates

Do not copy query results into a global Zustand store merely to share them. Use React Query's `queryClient.invalidateQueries` after mutations, as `config-prompt-sources.tsx` does for prompt and status keys. Use a Zustand action when the state is a durable client domain or needs to be updated synchronously by multiple views.

## Common Mistakes

- Do not add a new global store for state used by one component.
- Do not pass global store values through multiple component layers just to avoid importing the store.
- Do not save image data, video data, or large JSON through a new direct `localStorage` key.
- Do not use both React Query and a second cache for the same server-like resource without an explicit ownership reason.
