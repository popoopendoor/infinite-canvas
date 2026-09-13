import type { Database } from "../db.js";
import { hashToken, randomToken } from "../crypto.js";
import type { AuthUser } from "./oauth.js";

export type SessionRecord = {
  token: string;
  user: AuthUser;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
};

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly idleSeconds = 3 * 24 * 60 * 60,
    private readonly absoluteSeconds = 30 * 24 * 60 * 60,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  create(user: AuthUser) {
    const token = randomToken();
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO sessions (session_hash, user_id, username, display_name, avatar_url, created_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        hashToken(token),
        user.id,
        user.username,
        user.displayName,
        user.avatarUrl,
        now,
        now,
        now + this.absoluteSeconds,
      );
    return {
      token,
      user,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.absoluteSeconds,
    } satisfies SessionRecord;
  }

  getValid(token: string): SessionRecord | null {
    const now = this.now();
    const hash = hashToken(token);
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE session_hash = ? AND revoked_at IS NULL",
      )
      .get(hash) as SessionRow | undefined;
    if (!row) return null;
    if (
      row.absolute_expires_at <= now ||
      row.last_seen_at + this.idleSeconds <= now
    ) {
      this.db
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
        )
        .run(now, hash);
      return null;
    }
    const result = this.db
      .prepare(
        "UPDATE sessions SET last_seen_at = ? WHERE session_hash = ? AND revoked_at IS NULL AND absolute_expires_at > ? AND last_seen_at + ? > ?",
      )
      .run(now, hash, now, this.idleSeconds, now);
    if (result.changes !== 1) return null;
    return toSessionRecord(row, token, now);
  }

  revoke(token: string) {
    return (
      this.db
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
        )
        .run(this.now(), hashToken(token)).changes === 1
    );
  }
}

type SessionRow = {
  session_hash: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  created_at: number;
  last_seen_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
};

function toSessionRecord(
  row: SessionRow,
  token: string,
  lastSeenAt: number,
): SessionRecord {
  return {
    token,
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    createdAt: row.created_at,
    lastSeenAt,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}
