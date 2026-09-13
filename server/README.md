# Canvas BFF

The Canvas BFF owns Flarum OAuth, opaque website sessions, the published model catalog, provider calls, and Flarum `money` billing orchestration. It is an independent Node.js service; it is not a Flarum extension and never connects directly to the Flarum database.

## Local development

```bash
cd server
npm ci
npm run dev
```

The Vite app proxies `/auth`, `/api`, and `/health` to `http://localhost:3001`. The root Docker Compose files run Nginx and this BFF as separate services and persist SQLite state in `canvas-bff-data`.

## Flarum OAuth provider

Canvas includes a maintained `oauth-center/` fork of Flarum OAuth Center `v1.3.0`.
Install it as the same Composer package through the path repository shown in
[`oauth-center/README.md`](../oauth-center/README.md) before configuring the
OAuth client. It preserves existing Flarum OAuth clients and settings while
returning standard OAuth error redirects when authorization is declined.

## Required production configuration

| Variable                                            | Purpose                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                                        | Exact public Canvas origin used for Origin validation and cookies.                                                   |
| `FLARUM_BASE_URL`                                   | Flarum root URL used for OAuth endpoints.                                                                            |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`           | Confidential Flarum OAuth client credentials.                                                                        |
| `OAUTH_REDIRECT_URI`                                | Exact registered callback, normally `https://canvas.example.com/auth/callback`.                                      |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | Shared per-client limit for `/auth/login` and `/auth/callback`; defaults to 20 requests per 60 seconds.              |
| `BRIDGE_URL`                                        | Flarum API base URL, for example `https://forum.example.com/api`.                                                    |
| `BRIDGE_TOKEN`                                      | Private service token shared only with the Canvas Money Bridge.                                                      |
| `MODEL_CATALOG_JSON`                                | Catalog source for published model IDs, capabilities, provider adapters, fixed price versions, and integer prices.   |
| `MODEL_PROVIDER_KEYS_JSON`                          | Server-only JSON map from published model ID to its provider key; mapped models are available without a browser key. |
| `PROVIDER_BASE_URL_ALLOWLIST`                       | Comma-separated provider host names. It is mandatory in production.                                                  |

Production startup fails closed unless OAuth settings, `BRIDGE_URL`/`BRIDGE_TOKEN`,
`PROVIDER_BASE_URL_ALLOWLIST`, and at least one published model mapped in
`MODEL_PROVIDER_KEYS_JSON` are present. `OAUTH_REDIRECT_URI` must exactly be the
public Canvas `/auth/callback` URL; local development may use the
HTTP-compatible `docker-compose.local.yml` profile.
`OAUTH_CLIENT_ID` must be the exact client ID registered in Flarum OAuth Center;
the registered redirect URI must exactly match `OAUTH_REDIRECT_URI`.

## Production operation

Keep the deployment `.env` outside source control and readable only by the
deployment user. Do not put OAuth client secrets, bridge tokens, or provider
credentials in `VITE_*`, `config.js`, image build arguments, browser storage,
or support logs. Before exposing a release, validate without printing its
environment and confirm both services are healthy:

```bash
docker compose config -q
docker compose up -d --build
docker compose ps
curl --fail https://canvas.example.com/health
```

Publish catalog changes by using a new `priceVersion` for every price change,
then recreate only the BFF. Rotate an OAuth client secret in Flarum and the
deployment `.env` together. Rotate `BRIDGE_TOKEN` in the Flarum bridge setting
and `.env` together, then recreate the BFF; a mismatch rejects new wallet
requests instead of charging without a ledger record. Preserve the
`canvas-bff-data` volume for every restart, rollback, or credential rotation.
This deployment runs one BFF instance because its SQLite state is not a
multi-writer store.

`MODEL_CATALOG_JSON` is a JSON array. A minimal entry is:

```json
[
  {
    "id": "gpt-image-1",
    "capability": "image",
    "provider": "openai",
    "baseUrl": "https://api.openai.com",
    "model": "gpt-image-1",
    "priceVersion": "2026-09-07",
    "price": 3
  }
]
```

Prices and balances are non-negative safe integers: `1 money = 1` credit. Each catalog entry owns its provider base URL; the browser cannot submit or override it. The BFF rejects unpublished models, browser-supplied prices or provider URLs, missing allowlists, invalid encrypted BYOK credentials, and unavailable wallet bridges before calling a provider.

Managed provider URLs must expose the configured OpenAI-compatible paths through a
hostname with a certificate trusted by the BFF runtime. The BFF does not support
`--insecure`, custom TLS bypasses, or private IP addresses for provider origins.
Before enabling a paid model, verify that the provider reverse proxy
routes `/v1/chat/completions` and `/v1/images/generations` (as applicable) to the
actual API service; a router or application homepage returning HTML or `404` is
not a usable provider endpoint. Do not replace the public URL with an
internal service address to work around certificate or routing problems.

Add a model ID to `MODEL_PROVIDER_KEYS_JSON` to make it a Canvas-managed model.
The key map is read only by the BFF and is never included in `/api/models`, the
frontend bundle, the browser configuration, or the model script. Models absent
from the map remain BYOK models and require the browser's one-request RSA
envelope. For example, the deployment can publish the catalog entry above and
map `gpt-image-1` to its provider key without putting that key in the catalog:

```json
{ "gpt-image-1": "provider-key-from-the-deployment-secret-store" }
```

After login, the frontend adds mapped entries to read-only `Canvas managed`
providers. Models sharing the same public provider protocol and endpoint are
grouped together, and the first available managed model is selected for each
published capability. Every managed request still uses the same BFF task or
capability hold/capture flow; the browser cannot turn a managed entry into an
unpaid direct request. The managed provider endpoint is public routing metadata
only; its key remains server-only.

At startup, the BFF canonicalizes the configured array, calculates a content hash, and persists an immutable SQLite release with its entries. A changed configuration creates and activates a new release; restoring a previously seen configuration reactivates that release and records the transition. An unchanged configuration does not create a duplicate release. `GET /api/models` exposes the active release ID, hash, and activation time alongside its public model list. Treat `priceVersion` as immutable for a model: publish a new version before changing its price.

## Session and billing behavior

- Session idle expiry is three days; absolute expiry is thirty days. Only successful authenticated BFF requests renew idle time.
- OAuth access tokens and raw BYOK keys are never persisted. The browser encrypts a BYOK key using the short-lived BFF RSA public key for one request only.
- A task is held before execution, captured only after an explicit provider success, released only after an explicit provider failure, and marked `pending_reconciliation` when the provider or wallet outcome is unknown.
- Canceling a custom script revokes its capability. Cancellation and expiry leave the held task pending reconciliation only after its last active grant is gone. Expired capabilities are swept every minute. Neither case releases funds automatically.
- `POST /api/model-task-batches` accepts 1-20 child requests. Each child has its own idempotency key and billing lifecycle, so a batch can report successful, failed, and reconciliation-required children without combining their charges.
- The BFF downloads standard provider media from the configured provider origin before it returns a completed task. Custom browser-side model scripts first obtain a short-lived, task-bound capability; while it remains active, the BFF also resolves any returned provider media URL. The Worker receives the capability-bound catalog base URL and provider model, while the BFF replaces browser-supplied model fields and credentials. The script capability is captured or released through the same billing task.
- The public BFF routes are intended to be reverse-proxied through the Canvas Nginx origin. Do not expose the SQLite volume, bridge token, OAuth client secret, or provider credentials.
- Nginx access logs record only the request method and normalized path, never query parameters or `Referer`. Its request-level error log is disabled because upstream errors can echo a full request URL; use the BFF's redacted structured logs and health checks for diagnostics. This keeps OAuth codes, state, capability tokens, and provider credentials out of proxy logs.
- The local Compose profile uses `NODE_ENV=development` for its HTTP localhost origin. Production startup rejects non-HTTPS `APP_ORIGIN`, Flarum, or bridge URLs and sets secure cookies only for an HTTPS public origin.

## Reconciliation and recovery

`pending_reconciliation` is a hold state, not a retry queue. The BFF never
replays a provider request, captures, or releases it automatically. An operator
must first determine the provider outcome from the provider's own control plane
and inspect the matching Canvas task and bridge ledger.

List non-terminal tasks from inside the BFF container:

```bash
docker compose exec bff node dist/reconcile.js --list
```

For a confirmed provider success, capture the existing hold. New BFF versions
retain the confirmed provider output before a capture response becomes unknown:

```bash
docker compose exec bff node dist/reconcile.js --task TASK_ID --action capture
```

For an older task without a saved result, put the confirmed serializable result
in a protected JSON file mounted into the BFF container and pass its container
path with `--result-file`. The command reads but never prints that file.

```bash
docker compose exec bff node dist/reconcile.js --task TASK_ID --action capture --result-file /run/secrets/provider-result.json
```

For a confirmed provider failure, release the existing hold:

```bash
docker compose exec bff node dist/reconcile.js --task TASK_ID --action release
```

The command only accepts `pending_reconciliation` tasks. Capture and release
continue through the bridge's idempotent ledger routes, so a process failure
after a confirmed bridge response can be rerun safely. If the bridge cannot
confirm the operation, the task remains pending. Do not edit `model_tasks` or
bridge ledger rows directly, retry the provider, or refund an unknown result.

Before changing the catalog or rolling back the BFF image, stop new model task
creation and preserve the `canvas-bff-data` volume. Recreate the BFF with that
volume attached; in-flight work is marked for reconciliation at startup rather
than replayed. A rollback never deletes the volume or mutates bridge ledger
history.
