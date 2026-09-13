import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.js";
import { SessionStore } from "./session.js";

test("session expires after idle timeout and can be revoked immediately", () => {
  const db = openDatabase(":memory:");
  let now = 10_000;
  const sessions = new SessionStore(
    db,
    3 * 24 * 60 * 60,
    30 * 24 * 60 * 60,
    () => now,
  );
  const created = sessions.create({
    id: "42",
    username: "alice",
    displayName: "Alice",
    avatarUrl: "",
  });
  assert.equal(sessions.getValid(created.token)?.user.id, "42");
  now += 3 * 24 * 60 * 60 - 1;
  assert.equal(sessions.getValid(created.token)?.user.username, "alice");
  now += 3 * 24 * 60 * 60;
  assert.equal(sessions.getValid(created.token), null);

  now += 1;
  const second = sessions.create({
    id: "42",
    username: "alice",
    displayName: "Alice",
    avatarUrl: "",
  });
  assert.equal(sessions.revoke(second.token), true);
  assert.equal(sessions.getValid(second.token), null);
  db.close();
});

test("absolute expiry is not extended by activity", () => {
  const db = openDatabase(":memory:");
  let now = 20_000;
  const sessions = new SessionStore(db, 100, 200, () => now);
  const created = sessions.create({
    id: "7",
    username: "bob",
    displayName: "Bob",
    avatarUrl: "",
  });
  now += 90;
  assert.ok(sessions.getValid(created.token));
  now += 111;
  assert.equal(sessions.getValid(created.token), null);
  db.close();
});
