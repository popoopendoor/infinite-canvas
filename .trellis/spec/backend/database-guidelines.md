# Database Guidelines

> Current persistence reality for this project.

## Current State

There is no database, ORM, query builder, migration system, or transaction layer in the current repository; this is reflected by the dependencies and scripts in `canvas-agent/package.json` and the filesystem modules under `canvas-agent/src/`. Do not invent database conventions for a feature that only needs the existing local storage mechanisms.

The backend persists local configuration and agent data as files. For example, `canvas-agent/src/config.ts` reads and writes `~/.infinite-canvas/canvas-agent.json`, creates workspace directories, and explicitly sets file permissions. Agent history and message metadata also use filesystem modules in `canvas-agent/src/agent/codex-event-history.ts` and `canvas-agent/src/agent/message-metadata.ts`.

## Query Patterns

There are no database queries. Use the existing filesystem or in-memory abstractions when working within the current package, and keep serialization/deserialization close to the owning module. `canvas-agent/src/config.ts` uses `JSON.parse`/`JSON.stringify` for its file format; it is not a database API.

## Migrations and Transactions

There are no migrations or database transactions in `canvas-agent/package.json` or the current `canvas-agent/src/` modules. Do not add migration commands, schema versioning, an ORM dependency, or transaction wrappers as part of an unrelated feature. If a database is introduced later, update this document with the selected library, lifecycle, naming, migration, and transaction rules before implementation.
## Naming

No table, column, index, or query naming convention exists in the filesystem-only implementation. Local file names and JSON fields follow the owning module's TypeScript contracts instead; see `canvas-agent/src/config.ts`, `canvas-agent/src/agent/codex-event-history.ts`, and `canvas-agent/src/agent/message-metadata.ts`.

## Common Mistakes

- Do not describe local JSON/filesystem persistence as cloud synchronization or a relational database.
- Do not add a hypothetical `models/` or `repositories/` layer when no database is involved.
- Do not silently change the existing on-disk format or permission behavior in `canvas-agent/src/config.ts`; persistence changes need their own task and evidence.
