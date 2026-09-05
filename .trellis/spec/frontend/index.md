# Frontend Development Guidelines

> Evidence-backed conventions for the Vite React/TypeScript client in `web`.

## Guidelines Index

| Guide | Scope |
|-------|-------|
| [Directory Structure](./directory-structure.md) | Pages, layouts, components, services, hooks, stores, and shared utilities |
| [Component Guidelines](./component-guidelines.md) | Function components, props, Ant Design, styling, forms, and UI semantics |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, React Query, effects, and cache invalidation |
| [State Management](./state-management.md) | React local state, Zustand, React Query, routing, and persistence |
| [Type Safety](./type-safety.md) | Strict TypeScript, owned contracts, runtime boundaries, and narrowing |
| [Quality Guidelines](./quality-guidelines.md) | Available checks, current test limits, accessibility, and review points |

## Package Boundary

These guides describe `web`, the browser client. It directly calls configured external providers and the local Canvas Agent; do not assume a project backend or database is available for frontend features.
