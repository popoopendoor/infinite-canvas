import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import {
  OAuthClient,
  OAuthTransactionError,
  OAuthUpstreamError,
} from "./oauth.js";
import { safeReturnTo } from "./return-to.js";

function config() {
  return loadConfig({
    APP_ORIGIN: "https://canvas.example.test",
    FLARUM_BASE_URL: "https://forum.example.test",
    OAUTH_CLIENT_ID: "canvas",
    OAUTH_CLIENT_SECRET: "secret",
  });
}

test("OAuth transaction binds the browser transaction and is single-use", () => {
  const db = openDatabase(":memory:");
  let now = 1_000;
  const client = new OAuthClient(db, config(), () => now);
  const transaction = client.begin("/canvas");
  assert.match(client.authorizationUrl(transaction).toString(), /state=/);
  assert.equal(
    client.consume(transaction.state, transaction.transactionToken).return_to,
    "/canvas",
  );
  assert.throws(
    () => client.consume(transaction.state, transaction.transactionToken),
    OAuthTransactionError,
  );
  now += 601;
  const expired = client.begin("/");
  now += 601;
  assert.throws(
    () => client.consume(expired.state, expired.transactionToken),
    OAuthTransactionError,
  );
  db.close();
});

test("returnTo accepts only same-origin internal paths", () => {
  const serverConfig = config();
  assert.equal(
    safeReturnTo("/canvas/one?tab=2", serverConfig),
    "/canvas/one?tab=2",
  );
  assert.throws(() => safeReturnTo("https://attacker.example/", serverConfig));
  assert.throws(() => safeReturnTo("//attacker.example/", serverConfig));
  assert.throws(() => safeReturnTo("/\\\\attacker.example", serverConfig));
});
