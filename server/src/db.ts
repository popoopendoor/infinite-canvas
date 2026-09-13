import DatabaseDriver from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Database = InstanceType<typeof DatabaseDriver>;

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseDriver(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_states (
            state_hash TEXT PRIMARY KEY,
            transaction_hash TEXT NOT NULL,
            return_to TEXT NOT NULL,
            code_verifier TEXT,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions (
            session_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            avatar_url TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            absolute_expires_at INTEGER NOT NULL,
            revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS model_tasks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            model_id TEXT NOT NULL,
            capability TEXT NOT NULL,
            params_json TEXT NOT NULL,
            price_version TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL,
            hold_ledger_id TEXT,
            capture_ledger_id TEXT,
            release_ledger_id TEXT,
            provider_status TEXT,
            result_json TEXT,
            error_code TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS model_catalog_releases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash TEXT NOT NULL UNIQUE,
            catalog_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_catalog_entries (
            release_id INTEGER NOT NULL,
            model_id TEXT NOT NULL,
            capability TEXT NOT NULL,
            provider TEXT NOT NULL,
            base_url TEXT NOT NULL,
            provider_model TEXT,
            price_version TEXT NOT NULL,
            price INTEGER NOT NULL,
            PRIMARY KEY (release_id, model_id),
            FOREIGN KEY (release_id) REFERENCES model_catalog_releases(id)
        );
        CREATE TABLE IF NOT EXISTS model_catalog_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            active_release_id INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (active_release_id) REFERENCES model_catalog_releases(id)
        );
        CREATE TABLE IF NOT EXISTS model_catalog_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            release_id INTEGER NOT NULL,
            previous_release_id INTEGER,
            event_type TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (release_id) REFERENCES model_catalog_releases(id),
            FOREIGN KEY (previous_release_id) REFERENCES model_catalog_releases(id)
        );
        CREATE TABLE IF NOT EXISTS model_capabilities (
            token_hash TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            script_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER,
            FOREIGN KEY (task_id) REFERENCES model_tasks(id)
        );
        CREATE TABLE IF NOT EXISTS reconciliation_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(task_id, reason)
        );
        CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS model_tasks_status_idx ON model_tasks(status);
        CREATE INDEX IF NOT EXISTS model_catalog_entries_release_idx ON model_catalog_entries(release_id);
        CREATE INDEX IF NOT EXISTS model_catalog_entries_model_price_version_idx ON model_catalog_entries(model_id, price_version);
        CREATE INDEX IF NOT EXISTS model_catalog_events_release_idx ON model_catalog_events(release_id);
        CREATE INDEX IF NOT EXISTS model_capabilities_user_idx ON model_capabilities(user_id);
        CREATE INDEX IF NOT EXISTS model_capabilities_task_idx ON model_capabilities(task_id);
    `);
  return db;
}

export function markInFlightTasksForReconciliation(
  db: Database,
  now: number = Math.floor(Date.now() / 1000),
) {
  const result = db
    .prepare(
      "UPDATE model_tasks SET status = 'pending_reconciliation', provider_status = 'bff_restarted', error_code = 'bff_restarted', error_message = 'BFF restarted while the task was in flight', updated_at = ? WHERE status IN ('created', 'held', 'running')",
    )
    .run(now).changes;
  const pending = db
    .prepare(
      "SELECT id FROM model_tasks WHERE status = 'pending_reconciliation' AND provider_status = 'bff_restarted' AND updated_at = ?",
    )
    .all(now) as Array<{ id: string }>;
  for (const task of pending)
    recordReconciliation(db, task.id, "bff_restarted", now);
  return result;
}

export function recordReconciliation(
  db: Database,
  taskId: string,
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
) {
  db.prepare(
    "INSERT OR IGNORE INTO reconciliation_records (task_id, reason, created_at) VALUES (?, ?, ?)",
  ).run(taskId, reason, now);
}
