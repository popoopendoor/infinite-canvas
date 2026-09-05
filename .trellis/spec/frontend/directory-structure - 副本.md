# Frontend Directory Structure

> Current layout for the Vite React client in `web/src`.

## Overview

The frontend is organized by application responsibility rather than a single feature framework. Routes point to page entry modules in `web/src/pages/` through `web/src/router.tsx`, shared UI lives under `web/src/components/`, browser-side integrations live under `web/src/services/`, and cross-page state lives under `web/src/stores/`.

## Directory Layout

```text
web/src/
├── components/       # shared UI, grouped into agent/canvas/layout/prompts/ui
├── layouts/           # route layouts such as UserLayout
├── pages/             # route pages; feature pages commonly use index.tsx
├── router.tsx         # createBrowserRouter route table
├── hooks/             # cross-page stateful behavior and UI effects
├── services/api/      # browser-direct API/service functions
├── stores/            # Zustand stores; canvas/ contains canvas stores
├── lib/               # reusable non-UI helpers and canvas utilities
├── types/              # shared domain types
├── i18n/              # translations and locale setup
└── styles/             # global/base styles
```

Examples are `web/src/router.tsx`, `web/src/pages/assets/index.tsx`, `web/src/layouts/user-layout.tsx`, `web/src/services/api/canvas-agent.ts`, and `web/src/stores/canvas/use-canvas-store.ts`.

## Module Organization

- Add route pages under `web/src/pages/<feature>/`; the existing route table in `web/src/router.tsx` includes `/image`, `/video`, `/assets`, `/prompts`, `/canvas`, `/canvas/:id`, and `/config`.
- Put reusable UI in `web/src/components/`, grouping canvas, agent, layout, prompts, and primitive UI by responsibility. A component used only by one page may stay under that page's `components/` directory; `web/src/pages/assets/` is an existing page boundary.
- Put browser calls to external services in `web/src/services/api/`, such as `web/src/services/api/canvas-agent.ts` and `web/src/services/api/prompts.ts`. The current client calls providers or the local agent directly; do not assume a project backend exists between the browser and the service.
- Put cross-page Zustand state in `web/src/stores/`; canvas-specific state belongs in `web/src/stores/canvas/`, with `web/src/stores/canvas/use-canvas-store.ts` as the current example.
- Put a hook in `web/src/hooks/` only when it is shared across pages or components. Page-private hooks stay beside their page; shared examples include `web/src/hooks/use-prompt-source-scheduler.ts` and `web/src/hooks/use-copy-text.ts`.

## Naming

Use kebab-case file names such as `web/src/stores/use-asset-store.ts`, `web/src/components/layout/app-config-modal.tsx`, and `web/src/lib/localforage-storage.ts`; page directories expose their entry through `index.tsx`, as in `web/src/pages/assets/index.tsx`. Use PascalCase for React component functions and the `@/*` path alias configured in `web/tsconfig.json` for `src` imports.

Do not introduce a generic `Manager` component or a new shared directory for a single page when the existing page/component boundaries are sufficient; keep page-specific UI under its page, as with `web/src/pages/assets/`.
