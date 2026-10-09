# AI Hero commerce rig (draft, runtime proof pending)

A local MySQL 8 database, synthetic buyers, a Stripe test catalog, the real app checkout route, and a local Inngest server. This is test tooling only. It does not change application code, production configuration, or pricing rules.

**Not yet an E2E-verified rig.** Safety tests pass. The first runtime attempt could not access Docker, so schema push, seed, app startup and paid fulfillment are unverified. Named test-key leasing works. A repeat anonymous-provisioning guard probe returned the prefix **`rkcs_test_`**. It is outside the accepted `sk_test_` / `rk_test_` prefixes and was refused. The original probe's credential was deleted during cleanup; no key material is retained in this documentation. Do not merge or use the rig as evidence of production prices until the paid receipt passes.

## For agents

Requirements: Node 22+, installed workspace dependencies (`pnpm install --frozen-lockfile` from the repo root), Docker Compose v2 with socket access, the `secrets` CLI and a local agent-secrets daemon. Stripe CLI 1.53.1 and Inngest CLI 1.46.0 are invoked through pinned `npx` packages. No Stripe login is needed or permitted.

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

`up` preserves an existing seeded run and reuses healthy owned services. `reset` stops owned services, expires owned open sessions, archives owned Stripe prices/products, drops only `commerce_rig`, invokes the app's own `db:push`, seeds a fresh run and starts services. `down` stops owned services and Docker containers but preserves the database volume, Stripe artifacts and receipts. Use `reset` before `down` when provider cleanup is wanted. A failed seed requires `reset`, not hand-edited DB rows.

A crash can leave `command.lock`. Inspect its PID and owner before removing it; the rig refuses concurrent commands rather than guessing a stale lock is safe. The supervisor uses PID, `/proc` environment and exact script ownership checks. It never kills by process name.

## Stripe key source

```sh
# Default: lease the local named sandbox key for one hour at startup.
RIG_STRIPE=named ./scripts/commerce-rig/rig up

# Permanent-file alias, through the same reader; never source the file in a shell.
RIG_STRIPE_KEY_FILE="$HOME/.config/ai-hero-commerce-rig/stripe.env" ./scripts/commerce-rig/rig up

# Explicit source selector remains available.
RIG_STRIPE_KEY_SOURCE=file:/absolute/private/stripe.env ./scripts/commerce-rig/rig up

# Anonymous sandbox path; currently fenced when the CLI returns unsupported keys.
RIG_SLOT=1 RIG_STRIPE=ephemeral ./scripts/commerce-rig/rig up
```

The default source is `agent-secrets:ai-hero::stripe_test_secret_key`. `RIG_STRIPE_KEY_SOURCE` can select another `agent-secrets:<name>`, a `file:<absolute path>`, or `anonymous`. `RIG_STRIPE_KEY_FILE` is an alias for the file source; setting both overrides is refused. Leave both overrides unset to exercise the agent-secrets lease route. Both routes passed a checked-key/private-runtime-file probe. A file must be mode 0600, regular, and contain either a raw test key or `AIH_RIG_STRIPE_SECRET_KEY=<test key>` / `STRIPE_SECRET_TOKEN=<test key>`. Values are never printed. Ambient Stripe keys and CLI profiles are not used.

The named sandbox's expiry is operator-owned; `sandbox.json` records the lease times, not an invented sandbox expiration. Ephemeral provisioning records the returned account ID and expiry. It runs in a fresh private CLI home with a synthetic email. A one-shot proxy permits the anonymous provisioning host and package-download hosts, but blocks the CLI's account-login fallback. Unexpected key prefixes fail closed; `sandbox.json` records only the structural prefix alongside the candidate ID/expiry so a later policy decision can use evidence without exposing the key. Do not weaken that guard to make the command green.

The listener receives the checked key explicitly and writes its own `whsec` into the private runtime env. The route is **`/api/coursebuilder/webhook/stripe`**, verified from the installed Course Builder dispatcher. The app does not receive a dashboard webhook secret.

All intentional seed creates carry `metadata.rig=aihero-commerce` and `metadata.rig_run=<UUID>`. The private app's Node preload adds those fields to Stripe create requests, including nested payment-intent metadata on Checkout Sessions, without changing app source. Generated charges are tagged when seed/payment evidence is retrieved. Reset reconciles the journal against Stripe lists and only archives/expires objects with both exact ownership tags. It never deletes objects by name or touches another worker's run. Test customers, settled charges and refunds remain as audit history in the sandbox.

## Isolation and parallel runs

State lives under **`scripts/commerce-rig/.state/slot-N/`**, ignored by Git. Directories are 0700; credentials, env files, journals and receipts are 0600. Never commit or paste these files into a PR. The named test key remains in the local secret store; scratch-file handoffs are not required.

The app runs from a private mirror that excludes every original `.env*` file and `.next`. The rig copies `tsconfig.json` so Next cannot rewrite the source checkout's config. Child env is constructed from local values, never spread from the operator's environment. Vercel variables cannot redirect the app to production.

Only the exact rig TCP database URL is accepted. MySQL binds to loopback. Slot 0 uses app 3310, MySQL 13316, Inngest 8288 and gateway 8289. Set `RIG_SLOT=1` through `9` to reserve separate ports, state and Docker project/volume names; each slot adds 10 to these ports. Use the same slot and Stripe mode for every command in that run. Separate slots support independent named runs; ephemeral runs additionally isolate the Stripe account when provisioning succeeds.

The app preload allows outbound sockets only to its selected loopback ports and `api.stripe.com:443`. It also guards global fetch. This is a Node-process test fence, **not an OS security sandbox**. Native executables or an uninstrumented runtime are not covered. Browser checkout automation has its own request allowlist for the local app and Stripe domains.

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

There are 18 deterministic `*@example.test` users: new buyer; Crash Course paid 99/199/299; C3 and C4 alumni with no CC or each CC amount; legend; PPP-origin CC; refunded CC; redeemed team seat; team purchaser; binding-quote input. Histories use real settled Stripe **test** payments with linked charges when Stripe is seeded. Refunded history includes a real test refund. Team-seat history has a zero-paid redemption marker, not invented individual payment evidence.

The seed catalog is deliberately **synthetic and bare**. No customer dump, production coupon configuration, reviewed legend manifest or Front quote store is imported. Fixture types are not policy implementation. Legend and binding quote are explicit pending fact inputs in `seed.json`; their full eligibility is not represented by ordinary purchase rows. Existing price/credit selectors run unchanged. Add authoritative fact adapters/configuration in their owning projects before calling these two fixtures complete.

`checkout <fixture>` inserts a temporary local Auth.js database session and verifies the app resolves that exact buyer. It calls the real authenticated checkout route and retrieves Stripe's session total. Without `--complete`, it records and expires the session. With `--complete`, it submits **4242 4242 4242 4242** through the Stripe-hosted page, then waits for paid status, the matching stored webhook, a matching C5 purchase for the buyer/amount, and C5 access from that purchase. Browser selectors can drift; a failure produces a private screenshot and does not claim proof.

Private artifacts:

- `checkout-<fixture>.json`: source commit, run, session subtotal/discount/tax/total, paid state and fulfillment evidence.
- `price-table.json`: observed amounts against this checkout and **this synthetic catalog**, or explicit blocked rows. Not a production pricing table or the policy's desired numbers.
- `seed.json`, `artifacts.json`: fixture inputs, provider mappings and reset ownership.
- `runtime.env`, `stripe.env`: credentials, never include in reports.
- `runs/<previous-run>/`: receipts and journals preserved by reset.

A paid proof is complete only when the receipt's `complete` field is true and its purchase/access provenance matches C5. Production amounts cannot be inferred from a seeded bare catalog. Provider totals must be measured again after the real test configuration/fact adapters are installed.

## Preview environments

See [PREVIEW-OPTIONS.md](./PREVIEW-OPTIONS.md). This rig changes no Vercel environment, production database, provider integration or deployment.
