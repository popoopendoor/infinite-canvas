# Canvas Money Bridge

This is an independent Flarum extension for the Canvas BFF. It uses the package name `popoopendoor/canvas-money-bridge`, extension ID `popoopendoor-canvas-money-bridge`, namespace `Popoopendoor\CanvasMoneyBridge`, root `migrations/`, and `/api/canvas-money` routes so it cannot overwrite the legacy AI bridge.

The extension accepts only an opaque server-to-server token in the `X-Canvas-Bridge-Token` header, configured in the Flarum settings key `popoopendoor-canvas-money-bridge.service-token`. A dedicated header avoids collision with Flarum OAuth Center's `Authorization` middleware. The bridge routes are explicitly exempted from Flarum's browser CSRF check because they are authenticated service-to-service endpoints; the opaque bridge token remains the required authorization boundary. The browser must never receive this token. It exposes balance, hold, capture, and release operations for a stable Flarum user ID. The extension targets Flarum 1.8.x and keeps its migration in `migrations/`, matching the existing extension convention.

`users.money` is treated as a non-negative integer. Non-finite or fractional balances are rejected instead of rounded or truncated. Install and configure the extension only after reviewing the shared `users.money` writers and the deployment migration plan.

Install this source through Composer in the Flarum installation, enable `popoopendoor-canvas-money-bridge`, run Flarum migrations, and set `popoopendoor-canvas-money-bridge.service-token` to the same private value as the BFF's `BRIDGE_TOKEN`. Do not configure the token in forum-visible settings or browser code.

On upgrades, keep the existing `canvas_money_ledgers` table and run Flarum's
migrations after Composer installs the new extension source. The BFF owns task
state; use its server-only reconciliation command for a pending capture or
release. Do not update this ledger or `users.money` directly to compensate for
an unknown provider result.
