# Backend Development Guidelines

> Evidence-backed conventions for the `canvas-agent` Node/TypeScript package.

## Guidelines Index

| Guide | Scope |
|-------|-------|
| [Directory Structure](./directory-structure.md) | Entry points, server modules, domain directories, and test placement |
| [Database Guidelines](./database-guidelines.md) | Current filesystem-only persistence; no ORM or migration layer |
| [Error Handling](./error-handling.md) | Async route propagation, typed status errors, and JSON responses |
| [Logging Guidelines](./logging-guidelines.md) | Winston levels, debug files, lifecycle records, and redaction |
| [Quality Guidelines](./quality-guidelines.md) | Strict TypeScript, Node tests, build checks, and review points |

## Package Boundary

Backend-specific examples in these guides refer to `canvas-agent`. The repository also contains `canvas-proxy`, which is a small standalone proxy package; apply these rules only where the code structure matches the `canvas-agent` package.
