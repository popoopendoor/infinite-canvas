# OAuth BFF and Money Bridge Contract

## 1. Scope / Trigger

This applies to the `server/` Node.js BFF, the `bridge/` Flarum 1.8 extension,
the maintained `oauth-center/` Flarum OAuth provider fork, and browser model
requests in `web/src/services/api/`. The flow crosses OAuth, opaque sessions,
SQLite, the Flarum `money` balance, provider adapters, and the browser. Do not
bypass the BFF for a Canvas-originated model request.

## 2. Signatures

- BFF auth: `GET /auth/login`, `GET /auth/callback`, `GET /auth/session`, and
  `POST /auth/logout`.
- BFF models: `GET /api/models`, `GET /api/wallet`, `POST /api/model-tasks`,
  `POST /api/model-task-batches`, and `GET /api/model-tasks/:id`.
- Custom script capability: `POST /api/model-capabilities`,
  `POST /api/model-capabilities/request`,
  `POST /api/model-capabilities/complete`, and
  `POST /api/model-capabilities/abandon`. The short-lived capability is sent
  only in the `X-Canvas-Capability` header, never in a URL path or query.
- Bridge: `POST /api/canvas-money/{balance,hold,capture,release}` using the
  `X-Canvas-Bridge-Token` service header only. Do not use `Authorization`,
  because Flarum OAuth Center processes that header as an OAuth access token.
  These service routes are explicitly exempted from Flarum's browser CSRF
  check; the bridge token remains mandatory and is the service authorization
  boundary.
- BFF SQLite records: `oauth_states`, `sessions`, `model_tasks`, immutable
  `model_catalog_releases` and `model_catalog_entries`, active catalog state and
  release events, `model_capabilities`, and `reconciliation_records`.
- OAuth provider: `POST /oauth/authorize` and `POST /oauth/authorize/fetch`.
  The maintained fork keeps package `foskym/flarum-oauth-center`, extension ID
  `foskym-oauth-center`, and the existing setting keys. Install it as the
  `oauth-center/` Composer path package with a stable `1.3.1` path version.

## 3. Contracts

- Website sessions are opaque HttpOnly cookies. The database stores only their
  hash; idle expiry is three days and absolute expiry is thirty days.
- `/auth/login` and `/auth/callback` share an in-process per-client fixed-window
  limit. Nginx is the one trusted proxy hop; a limited request redirects to the
  retryable `rate_limited` error page without creating or consuming a transaction.
- Local HTTP development is allowed, but production startup requires HTTPS for
  the public Canvas origin, Flarum OAuth base URL, and bridge URL; secure cookie
  behavior follows the public origin protocol.
- Mutating BFF routes require a valid session and an `Origin` equal to
  `APP_ORIGIN`. Browser input never controls user ID, price, price version, or
  provider base URL.
- `MODEL_CATALOG_JSON` is the controlled source of published model IDs,
  capability, provider, base URL, fixed price version, and non-negative
  safe-integer price. Startup validates and canonicalizes it into an immutable
  SQLite release; a changed source creates a release, and reusing a prior source
  reactivates its existing release with an audit event. Production also requires
  `PROVIDER_BASE_URL_ALLOWLIST` and at least one catalog entry mapped by
  `MODEL_PROVIDER_KEYS_JSON`.
- `MODEL_PROVIDER_KEYS_JSON` is server-only. `/api/models` may return only safe
  routing metadata (`provider`, `apiFormat`, and a credential-free `baseUrl`),
  never provider keys. The browser groups managed entries by provider and
  endpoint; managed channel routing and model membership are server-owned.
- BYOK values are RSA-OAEP envelopes. They are decrypted only for the current
  BFF provider request and must not be persisted or logged.
- Provider requests, polling, media downloads, and custom capability proxies
  use `redirect: "error"`. The validated provider origin is the only network
  destination; never follow a redirect that could bypass the allowlist or send
  provider credentials to a private address. If a provider returns an absolute
  HTTP media URL with the exact configured HTTPS hostname and port, normalize
  that URL to HTTPS before the origin check; reject every other protocol,
  hostname, or port change.
- A bridge mutation contains `userId`, `taskId`, `amount`, and `requestHash`.
  The bridge rejects fractional/negative `users.money`, replay conflicts, and
  insufficient balance. The Flarum 1.8 extension migration belongs only in
  `bridge/migrations/`.
- Once a hold succeeds, a confirmed capture or release must persist its ledger
  ID on the BFF task before it enters a terminal state. An unknown wallet result
  has no confirmed ledger ID and must remain `pending_reconciliation`.
- Custom scripts run in a Worker. The Worker receives neither the short-lived
  capability token nor the saved provider key; its `apiKey` input is only an
  inert managed-provider marker. The BFF returns the capability-bound catalog
  base URL and provider model for the Worker's `baseUrl` and `model` inputs. The
  page keeps the capability and sends it in the private `MessageChannel` request
  as `X-Canvas-Capability`; the BFF enforces the task-bound provider origin,
  replaces standard model fields and Gemini model paths, removes credential
  query parameters, and replaces browser credentials. This is defense in depth,
  not a hostile-code sandbox.
- A batch submission contains one or more normalized model requests, with a
  maximum of 20 child requests. Every child keeps its own idempotency key,
  model task, wallet hold/capture/release records, and reconciliation state;
  the aggregate status never replaces child task status.
- OAuth provider approval is strict: only boolean `true`, string `"true"`,
  integer `1`, or string `"1"` may authorize. Form buttons submit their own
  `is_authorized` value; Fetch derives it from `SubmitEvent.submitter`. For a
  valid request, both modes return the OAuth server's redirect location, so a
  refusal carries `error=access_denied` and the original `state` to the BFF.

## 4. Validation and Error Matrix

| Condition                                                     | Required result                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Missing or revoked session                                    | `401 unauthenticated`                                                                             |
| Session storage failure                                       | `503 service_unavailable`; do not redirect as anonymous                                           |
| Missing or mismatched Origin on mutation                      | `403 forbidden`                                                                                   |
| Malformed model or batch payload                              | `400 bad_request`                                                                                 |
| OAuth HTTP 200 body with `error`                              | Failed callback; no session cookie                                                                |
| `is_authorized=false`, `"false"`, omitted, or any other value | OAuth denial redirect; no authorization code or session                                           |
| Fetch authorization response without a redirect location      | `400 invalid_request`; keep the authorization page usable and do not navigate                     |
| Unpublished model or mismatched capability                    | `400 bad_request`                                                                                 |
| Same idempotency key with changed normalized request          | `409 conflict`                                                                                    |
| Known insufficient balance                                    | `409 conflict`; provider is not called                                                            |
| Wallet service unavailable before hold                        | `503 wallet_unavailable`; provider is not called                                                  |
| Provider or wallet result is unknown                          | `pending_reconciliation`; no automatic refund or retry                                            |
| Provider response redirects                                   | Reject the redirect; do not send credentials to its target                                        |
| Explicit provider failure after hold                          | Release exactly once, then `failed`                                                               |
| Capture/release response lost after success                   | Same user may replay completion to read the existing terminal task; never invoke the wallet twice |

## 5. Good, Base, and Bad Cases

- Good: A session-bound request resolves a published entry, holds its fixed
  integer price, calls the provider, captures once, and persists `succeeded`.
- Base: A custom Worker asks the BFF proxy for a relative provider path and
  completes the short-lived capability with a serializable result.
- Bad: A browser submits a different provider URL, a price, another user ID,
  a raw key, or a cross-origin capability token. Reject it before provider
  execution.
- Good: The form's approval button posts `is_authorized=true`; Fetch approval
  sends JSON `true`; both return to Canvas with an authorization code.
- Base: Either denial returns the client callback with `access_denied` and
  `state`; the BFF consumes state once and renders its retryable error page.
- Bad: A hidden `"false"` field is cast with PHP `(bool)`, or Fetch returns a
  body without `location`; both break denial semantics and must not ship.

## 6. Tests Required

- `server/src/auth/*.test.ts`: state single-use, return URL validation, idle and
  absolute expiry, and logout revocation.
- `server/src/billing/tasks.test.ts` and `custom-capability.test.ts`: hold,
  capture/release, idempotency, concurrent custom starts, terminal completion
  replay, unknown-result reconciliation, a release ledger ID when capability
  setup fails after a successful hold, and independent batch outcomes.
- `server/src/http.test.ts`: authenticated custom capability start/proxy/
  complete path, Origin rejection, user binding, and credential replacement.
- Run `npm test`, `npm run typecheck`, and `npm run format:check` in `server/`;
  run the applicable `web` build/type check and bridge PHP/Composer checks.
- For `oauth-center/`, lint every PHP source file, run Prettier only on the
  changed forum component, build `js/dist/forum.js`, and run real Flarum
  browser checks for form and Fetch approval plus denial. Restore temporary
  test overrides and disable Fetch mode after the test.

## 7. Common Mistake: Container OAuth Configuration

`FLARUM_BASE_URL` is the browser-visible Flarum origin used for the authorize
redirect. `FLARUM_INTERNAL_BASE_URL` is the address used by the BFF for token
exchange and userinfo; Docker deployments must pass it through Compose when
the public Flarum host resolves to the container itself or to `127.0.0.1`.
`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `OAUTH_REDIRECT_URI` must be one
registered Flarum client tuple. A valid-looking ID or secret from another
client produces a generic error on `/oauth/authorize` or a failed callback.
The `BRIDGE_TOKEN` must likewise match the bridge setting exactly. Check these
pairs before changing model catalog or provider-key configuration; model keys
do not participate in the OAuth handshake.

For local HTTP testing use `docker-compose.local.yml`; the production Compose
file intentionally rejects non-HTTPS origins. Validate the expanded
configuration without printing secret values:

```bash
docker compose --env-file .env -f docker-compose.local.yml config -q
docker compose --env-file .env -f docker-compose.local.yml up -d --build --force-recreate
```

## 8. Wrong vs Correct

### Wrong

```ts
await fetch(userSuppliedProviderUrl, {
  headers: { Authorization: `Bearer ${savedBrowserKey}` },
});
```

### Correct

```ts
const grant = await startModelCapability(input);
const result = await requestModelCapability(grant.token, taskBoundRequest);
await completeModelCapability(grant.token, true, result);
```

### Wrong

```php
$isAuthorized = (bool) $params['is_authorized'];
```

### Correct

```php
$isAuthorized = in_array($params['is_authorized'] ?? null, [true, 'true', 1, '1'], true);
```

The BFF derives the user and price from the session and catalog, while the
bridge is the authority for balance mutations and ledger state.
