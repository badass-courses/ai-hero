# AI Hero status tracer

This workspace is a credential-free Cloudflare Worker tracer for the AI Hero status system.

It keeps detector evidence, incident truth, investigation evidence, proposals, approvals, and public output in separate boundaries. One SQLite-backed Durable Object serializes incident writes. XState v5 owns legal incident transitions. Effect v4 schemas reject unknown fields at external and persisted JSON boundaries.

## Local commands

From the repository root:

```sh
pnpm --filter @ai-hero/status lint
pnpm --filter @ai-hero/status format:check
pnpm --filter @ai-hero/status typecheck
pnpm --filter @ai-hero/status test
pnpm --filter @ai-hero/status build
```

`pnpm --filter @ai-hero/status dev` starts Wrangler locally. The checked-in Wrangler configuration keeps all mutation switches off.

A fresh store reports `unknown`, with every component also `unknown`. The public page says `Status checks are not armed` until approved evidence produces a status projection. An approved incident changes only its affected component. If any other component is still unknown, recovery returns the overall status to `unknown` instead of making a false all-systems-operational claim.

Incident history is append-only for every accepted evidence event. Incident versions change only on lifecycle transitions, so several immutable history rows can share one incident version. The fresh v1 SQLite schema does not enforce uniqueness on `(incident_id, incident_version)` in `incident_history`.

## Routes

| Route                      | Access                                        | Cache               |
| -------------------------- | --------------------------------------------- | ------------------- |
| `GET /`                    | anonymous                                     | public, short-lived |
| `GET /status.json`         | anonymous                                     | public, short-lived |
| `GET /admin/status.json`   | admin bearer token                            | private, no-store   |
| `POST /v1/detector-events` | timestamped HMAC                              | private, no-store   |
| `POST /__tracer/replay`    | tracer bearer token and `TRACER_ENABLED=true` | private, no-store   |

The replay route accepts only versioned detector events, fake approvals, and fake investigation results. It has no live provider adapters.

## Bindings

Wrangler-generated runtime bindings live in `worker-configuration.d.ts`. Secret bindings are declared separately in `src/secrets-env.d.ts`:

- `INCIDENTS`
- `ADMIN_BEARER_TOKEN`
- `DETECTOR_HMAC_SECRET`
- `TRACER_BEARER_TOKEN`
- `TRACER_ENABLED`
- `STATUS_AUTOMATION_ENABLED`
- `STATUS_PUBLIC_WRITES_ENABLED`

Do not put real token values in this repository. Tests inject obvious fixture values through the official Cloudflare Vitest pool.

## Not wired yet

This tracer does not include live Devin, Axiom, Slack, SSO, Workflows, Cron Triggers, deploy credentials, DNS, or a vanity hostname. Fake adapters prove the typed boundaries and side-effect guards. Parent review is required before any private `workers.dev` preview.
