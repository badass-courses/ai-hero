# AI Hero commerce rig

A local MySQL 8 database, synthetic buyers, a Stripe test catalog, the real app checkout route, and a local Inngest server. This is test tooling only. It does not change application code, production configuration, or pricing rules.

**Status:** `rig checkout new-buyer --complete` passes end to end on macOS (Docker Desktop/OrbStack) with the named Stripe sandbox: a hosted test-card payment, the forwarded `checkout.session.completed` webhook, a matching Valid C5 purchase and a matching C5 entitlement, all read back. Linux hosts keep working through the same code paths. The anonymous-provisioning route is still fenced: the CLI returned the prefix **`rkcs_test_`**, outside the accepted `sk_test_` / `rk_test_` prefixes. Measured totals describe today's checkout code against this synthetic catalog, not production configuration.

## For agents

Requirements: Node 24+, installed workspace dependencies (`pnpm install --frozen-lockfile` from the repo root), `rsync`, Docker Compose v2 with socket access, the `secrets` CLI and a local agent-secrets daemon. Stripe CLI 1.53.1 and Inngest CLI 1.46.0 are invoked through pinned `npx` packages. No Stripe login is needed or permitted.

From the development checkout:

```sh
cd apps/ai-hero
node --test scripts/commerce-rig/rig.test.mjs
./scripts/commerce-rig/rig fixtures
./scripts/commerce-rig/rig up
./scripts/commerce-rig/rig status
./scripts/commerce-rig/rig checkout new-buyer
pnpm exec playwright install chromium
./scripts/commerce-rig/rig checkout new-buyer --complete
./scripts/commerce-rig/rig prices
./scripts/commerce-rig/rig reset
./scripts/commerce-rig/rig down
```

Run startup, reset and paid checkout in an owned terminal pane or background job when acting as an agent. They can take several minutes. Each step reports `ok` or its failed step. A failed step is not readiness. A running status requires the owned supervisor plus HTTP health responses from the app and jobs server.

`up` preserves an existing seeded run and reuses healthy owned services. `reset` stops owned services, expires owned open sessions, archives owned Stripe prices/products, drops only `commerce_rig`, applies the app schema, seeds a fresh run and starts services.

**Schema.** `drizzle-kit push` reported success while MySQL 8 rejected `timestamp(3) ... ON UPDATE CURRENT_TIMESTAMP`. The rig therefore runs `drizzle-kit generate` against the app's own schema into private state, applies a rig-only overlay (`ON UPDATE CURRENT_TIMESTAMP(3)` for fractional timestamps), executes each statement with errors fatal, and then requires every table and column in drizzle's snapshot to exist in `information_schema`. A missing table or column fails `up`. On an already populated database it only verifies; a partial apply needs `reset`. The app's source schema and migrations are unchanged. `down` stops owned services and Docker containers but preserves the database volume, Stripe artifacts and receipts. Use `reset` before `down` when provider cleanup is wanted. A failed seed requires `reset`, not hand-edited DB rows.

A crash can leave `command.lock`. Inspect its PID and owner before removing it; the rig refuses concurrent commands rather than guessing a stale lock is safe. The supervisor uses PID, process environment (`/proc` on Linux, `ps eww` on macOS) and exact script/state-path ownership checks. It never kills by process name.

## Stripe key source

```sh
# Lease a named sandbox key from agent-secrets for one hour at startup.
RIG_STRIPE_KEY_SOURCE=agent-secrets:<secret name> ./scripts/commerce-rig/rig up

# Permanent-file alias, through the same reader; never source the file in a shell.
RIG_STRIPE_KEY_FILE="$HOME/.config/ai-hero-commerce-rig/stripe.env" ./scripts/commerce-rig/rig up

# Explicit source selector remains available.
RIG_STRIPE_KEY_SOURCE=file:/absolute/private/stripe.env ./scripts/commerce-rig/rig up

# Anonymous sandbox path; currently fenced when the CLI returns unsupported keys.
RIG_SLOT=1 RIG_STRIPE=ephemeral ./scripts/commerce-rig/rig up
```

There is no default key source. Named mode requires `RIG_STRIPE_KEY_SOURCE` set to `agent-secrets:<name>`, `file:<absolute path>` or `anonymous`, and refuses to start when it is unset. Keep the secret name in your private operator setup, not in this repo. `RIG_STRIPE_KEY_FILE` is an alias for the file source; setting both is refused. Both routes passed a checked-key/private-runtime-file probe. A file must be mode 0600, regular, and contain either a raw test key or `AIH_RIG_STRIPE_SECRET_KEY=<test key>` / `STRIPE_SECRET_TOKEN=<test key>`. Values are never printed. Ambient Stripe keys and CLI profiles are not used.

The named sandbox's expiry is operator-owned; `sandbox.json` records the lease times, not an invented sandbox expiration. Ephemeral provisioning records the returned account ID and expiry. It runs in a fresh private CLI home with a synthetic email. A one-shot proxy permits the anonymous provisioning host and package-download hosts, but blocks the CLI's account-login fallback. Unexpected key prefixes fail closed; `sandbox.json` records only the structural prefix alongside the candidate ID/expiry so a later policy decision can use evidence without exposing the key. Do not weaken that guard to make the command green.

The listener receives the checked key explicitly and writes its own `whsec` into the private runtime env. The route is **`/api/coursebuilder/webhook/stripe`**, verified from the installed Course Builder dispatcher. The app does not receive a dashboard webhook secret.

All intentional seed creates carry `metadata.rig=aihero-commerce` and `metadata.rig_run=<UUID>`. The private app's Node preload adds those fields to Stripe create requests, including nested payment-intent metadata on Checkout Sessions, without changing app source. Generated charges are tagged when seed/payment evidence is retrieved. Reset reconciles the journal against Stripe lists and only archives/expires objects with both exact ownership tags. It never deletes objects by name or touches another worker's run. Test customers, settled charges and refunds remain as audit history in the sandbox.

## Isolation and parallel runs

State lives under **`scripts/commerce-rig/.state/slot-N/`**, ignored by Git. Directories are 0700; credentials, env files, journals and receipts are 0600. Never commit or paste these files into a PR. The named test key remains in the local secret store; scratch-file handoffs are not required.

The app runs from a private mirror: an `rsync` copy of the app source that excludes every original `.env*` file, `.next` and the rig's own state, plus a link to `node_modules`. Turbopack does not discover routes through a symlinked `src/app`, so the mirror is a real copy, refreshed on each `up`. A rig-only `next.config.mjs` wraps the original and pins `turbopack.root` to the monorepo, because Turbopack otherwise infers a root from any lockfile above the checkout. The workspace packages the app imports from `dist/` are built before startup, as the app's `prebuild` does. Child env is constructed from local values, never spread from the operator's environment. Vercel variables cannot redirect the app to production.

Only the exact rig TCP database URL is accepted. MySQL binds to loopback. Slot 0 uses app 3310, MySQL 13316, Inngest 18288, gateway 18289 and Inngest gRPC 18290/18291. The rig avoids Inngest's default 8288, which a real Inngest server may own, and `up` refuses to start when any service port already accepts connections. Set `RIG_SLOT=1` through `9` to reserve separate ports, state and Docker project/volume names; each slot adds 10 to these ports. Use the same slot and Stripe mode for every command in that run. Separate slots support independent named runs; ephemeral runs additionally isolate the Stripe account when provisioning succeeds.

The app preload allows outbound sockets only to its selected loopback ports and `api.stripe.com:443`. The one addition is Turbopack's loader IPC: a process whose entry script is inside the rig's own `.next` may connect to the loopback port in its argv. It also guards global fetch. This is a Node-process test fence, **not an OS security sandbox**. Native executables or an uninstrumented runtime are not covered. Browser checkout automation has its own request allowlist for the local app and Stripe domains.

| Integration | Rig behavior |
| --- | --- |
| Stripe | Checked test key, tagged test objects, real Checkout/webhook transport |
| MySQL | Owned Docker MySQL 8.0.43 and synthetic schema/rows only |
| Inngest | Local dev server, explicit app discovery URL, no cloud event/signing credentials |
| Kit/ConvertKit | Dummy import-time values; outbound provider calls blocked |
| Postmark/email | Dummy import-time values; outbound sends blocked, not simulated successful sends |
| Front/front-desk | No credential; outbound calls blocked; quote lookup not stubbed as empty success |
| drovr | No URL or executor credential; ownership/DOI switches absent |
| Discord/Slack/GitHub OAuth | No credentials; no role/message/provider writes |
| OpenAI/Mux/Cloudinary/Deepgram | Dummy required values; outbound calls blocked |
| Redis/UploadThing/PartyKit | Disabled loopback endpoint, no external credentials |
| Search/analytics/storage/calendar/Zoom | No credentials; remote calls blocked |

Provider-dependent jobs may therefore fail explicitly in the local job UI. That is not a production outage, and the rig does not counterfeit provider success. A missing local fulfillment receipt is still a failed proof, even if Stripe says paid.

## Fixtures and receipts

There are 22 deterministic `*@example.test` users: new buyer; Crash Course paid 99/199/299; C3 and C4 alumni with no CC or each CC amount; legend (owns all six paid courses); PPP-origin CC; refunded CC; redeemed team seat; team purchaser with earlier seats; fresh team orders at the first quantity of each seat band (2, 5, 10, 30); binding-quote input. Seeded commerce rows are active (`status = 1`), and fixture memberships carry an owner role the way personal-org provisioning creates them. Histories use real settled Stripe **test** payments with linked charges when Stripe is seeded. Refunded history includes a real test refund. Team-seat history has a zero-paid redemption marker, not invented individual payment evidence.

The seed catalog is deliberately **synthetic and bare**. No customer dump, production coupon configuration, reviewed legend manifest or Front quote store is imported. The one discount configuration seeded is Course Builder's generic bulk coupons, at the tiers the installed `@coursebuilder/commerce` reports, because bulk checkout looks them up by type and tier. Fixture types are not policy implementation. Legend and binding quote are explicit pending fact inputs in `seed.json`; their full eligibility is not represented by ordinary purchase rows. Existing price/credit selectors run unchanged. Add authoritative fact adapters/configuration in their owning projects before calling these two fixtures complete.

`checkout <fixture>` inserts a temporary local Auth.js database session and verifies the app resolves that exact buyer. It POSTs to the real authenticated checkout route as the buy form does, follows the app's same-origin `/subscribe/verify-login` hop for cohort products, and retrieves Stripe's session total. Without `--complete`, it records and expires the session. With `--complete`, it selects the card method, opts out of Link and submits **4242 4242 4242 4242** through the Stripe-hosted page, then waits for paid status, the matching stored webhook, a matching C5 purchase for the buyer whose stored `totalAmount` equals Stripe's total to the cent (and whose saved pricing decision, if any, names this session and total), and C5 access from that purchase. Browser selectors can drift; a failure produces a private screenshot plus a control-name list (no values) and does not claim proof.

**C5 pricing policy is required for checkout.** Start or reset with `RIG_FRONT_DESK_DATA=/absolute/private/front-desk-data.json` to enable the existing loopback policy/quote stub. Use `RIG_CATALOG_OVERLAY` too when reproducing a privately recorded price baseline. Neither input is production state; keep both outside the public repo. Restart owned services when changing the policy input, and reset when changing the catalog input.

Without a policy fixture, the authoritative hook correctly holds checkout with `policy-unavailable`. The SDK may wrap its app error URL inside `/subscribe/verify-login?checkoutUrl=...`; following that hop looks like a login error even though the session cookie was valid. The rig now detects this provider refusal before following it. Supply the fixture, do not loosen authentication, the pricing gate, or the Stripe-host redirect check.

**List prices.** Public fixtures use synthetic list prices; the C5 fixture is deliberately not the real price. A measurement run can supply real amounts from a private JSON file outside the repo:

```sh
# { "amounts": { "c5": <cents> } }; keys are catalog keys in fixtures.mjs.
RIG_CATALOG_OVERLAY=/absolute/private/catalog-overlay.json ./scripts/commerce-rig/rig reset
```

The overlay must be an absolute path to a regular file. Unknown keys and non-integer or non-positive amounts are refused. `seed.json` and each checkout receipt record whether an overlay was used. Changing the overlay on a seeded run requires `reset`. Keep measured totals in private receipts.

Private artifacts:

- `checkout-<fixture>.json`: source commit and whether the rig tree was dirty, run, session subtotal/discount/tax/total, paid state and fulfillment evidence.
- `price-table.json`: observed amounts against this checkout and **this synthetic catalog**, or explicit blocked rows. Not a production pricing table or the policy's desired numbers.
- `seed.json`, `artifacts.json`: fixture inputs, provider mappings and reset ownership.
- `runtime.env`, `stripe.env`: credentials, never include in reports.
- `runs/<previous-run>/`: receipts and journals preserved by reset.

A paid proof is complete only when the receipt's `complete` field is true and its purchase/access provenance matches C5. Production amounts cannot be inferred from a seeded bare catalog. Provider totals must be measured again after the real test configuration/fact adapters are installed.

## Preview environments

See [PREVIEW-OPTIONS.md](./PREVIEW-OPTIONS.md). This rig changes no Vercel environment, production database, provider integration or deployment.
