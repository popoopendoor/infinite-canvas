# Frontend Quality Guidelines

> Quality checks and review expectations currently available in the `web` package.

## Available Checks

`web/package.json` provides `npm run typecheck` (`tsc --noEmit`), `npm run format:check` (`prettier --check .`), `npm run build` (`vite build`), and the Vite dev/preview commands. There is no frontend lint script and no frontend test script in the current package. A repository scan found no frontend test files or configured frontend test runner; do not claim that a UI change is covered by tests that do not exist.

Run the checks relevant to the changed surface from `web/package.json` and `web/tsconfig.json`, and report any unavailable check honestly. TypeScript errors and formatting failures should be fixed rather than hidden with compiler/config changes.

## Required Patterns

- Keep external service calls in `web/src/services/api/` and use typed service contracts.
- Use existing Zustand stores, React Query, React Router, Ant Design providers, i18n, and theme helpers; current integration points include `web/src/components/layout/app-providers.tsx`, `web/src/stores/`, and `web/src/router.tsx`.
- Use translated UI strings through `useTranslation()`; configuration UI examples are in `web/src/components/layout/app-config-modal.tsx` and `web/src/components/layout/config-local-proxy.tsx`.
- Keep component styles local with Tailwind or small inline styles; shared theme and Ant Design token changes belong in `web/src/lib/app-theme.ts` or the provider layer in `web/src/components/layout/app-providers.tsx`.
- Preserve accessible native/Ant Design controls, labels, focusable buttons, and safe external links when changing UI; `web/src/components/layout/config-prompt-sources.tsx` shows the current link/button patterns.

Examples include `web/src/components/layout/app-providers.tsx`, `web/src/components/layout/config-local-proxy.tsx`, `web/src/components/layout/config-prompt-sources.tsx`, and `web/src/router.tsx`.

## Review Checklist

Before considering a frontend change complete, review:

- route placement and page directory ownership are consistent with `web/src/router.tsx` and a page entry such as `web/src/pages/assets/index.tsx`;
- state belongs in local React state, an existing Zustand store, React Query, or the URL, with the current ownership examples in `web/src/stores/` and `web/src/components/layout/config-prompt-sources.tsx`;
- API work stays in a service module such as `web/src/services/api/canvas-agent.ts` rather than embedded in JSX;
- loading, error, empty states, and async cleanup are handled like the query UI in `web/src/components/layout/config-prompt-sources.tsx` and the scheduler in `web/src/hooks/use-prompt-source-scheduler.ts`;
- mobile/layout behavior, translated text, semantic controls, and theme compatibility are checked against `web/src/components/layout/app-providers.tsx` and the UI patterns in `web/src/components/layout/config-local-proxy.tsx`;
- the diff avoids unrelated refactors and unnecessary prop forwarding, consistent with the direct state/prop boundary in `web/src/components/canvas/canvas-side-panel.tsx`.

For a change affecting `web`, use `npm run typecheck` and `npm run format:check`; use `npm run build` when the task or environment calls for a production bundle. There is no evidence for a coverage threshold or mandatory component-test framework.

## Avoid

Do not add generic lint/test requirements to this package, bypass strict TypeScript, put business data in direct `localStorage` when `localforage` is appropriate, or hard-code a canvas color/theme branch that conflicts with the shared theme system.
