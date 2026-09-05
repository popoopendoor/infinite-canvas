# Component Guidelines

> React component patterns currently used by the `web` package.

## Component Structure

Use function components and existing hooks. Define a small local `Props` type when a component accepts props, and keep stateful behavior close to the UI that owns it. `web/src/components/canvas/canvas-side-panel.tsx` defines a typed props object and reads shared theme/panel state directly; `web/src/components/layout/app-config-modal.tsx` uses local state plus selectors from `useConfigStore`.

```tsx
type Props = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (nodeId: string) => void;
};

export function CanvasSidePanel({ nodes, selectedNodeIds, onFocusNode }: Props) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // render the panel...
}
```

Use direct store/hook access for genuinely global state rather than threading global values through several layers; `web/src/components/canvas/canvas-side-panel.tsx` reads `useThemeStore` directly, while `web/src/components/layout/app-config-modal.tsx` reads `useConfigStore`. Keep props for data and callbacks that belong to the component boundary.

## UI Libraries and Styling

Use Ant Design controls and the existing providers in `web/src/components/layout/app-providers.tsx` for forms, tabs, buttons, messages, modal confirmation, and configuration. Use `lucide-react` or existing Ant Design icons for action icons. Examples include `web/src/components/layout/app-config-modal.tsx`, `web/src/components/layout/config-local-proxy.tsx`, and `web/src/components/layout/config-prompt-sources.tsx`.

Use Tailwind classes and small component-local inline styles for component styling. Canvas components read colors from `canvasThemes`/`useThemeStore`; do not hard-code a light-only palette in a canvas component. Global theme and Ant Design tokens are configured through `web/src/lib/app-theme.ts` and `web/src/components/layout/app-providers.tsx`.

## Forms and Feedback

Existing configuration forms use Ant Design `Form`/`Form.Item` for layout while values are controlled by Zustand selectors and update actions. `web/src/components/layout/config-local-proxy.tsx` binds `Input` and `Switch` directly to `useConfigStore`, and `web/src/components/layout/app-config-modal.tsx` updates channel/preferences state through store actions. For async actions, keep a local loading flag, show success/error feedback with `App.useApp().message`, and reset the flag in `finally`.

## Composition and Accessibility

Prefer the real Ant Design or project component at the call site over a wrapper that only forwards `children` or props. Preserve semantic buttons/links, visible labels or translated labels, keyboard-operable controls, and safe external-link attributes such as `target="_blank"` with `rel="noreferrer"` used in `web/src/components/layout/config-prompt-sources.tsx`. The project does not currently have a separate accessibility test suite, so keep these semantics in the component implementation.

## User-Facing Text
Use `useTranslation()` and existing i18n keys for product UI text. Current components such as `web/src/components/layout/app-config-modal.tsx`, `web/src/components/layout/config-local-proxy.tsx`, and `web/src/components/layout/config-prompt-sources.tsx` obtain labels and feedback strings through `t(...)`.

Do not add a presentational wrapper only to rename an existing component, pass a large set of unrelated props through a tree, or duplicate theme branches that belong in the shared theme provider.
