# API Request Telemetry (`withSkill`)

`withSkill` is the request-level telemetry wrapper for Next.js API routes in AI Hero.

Source: `apps/ai-hero/src/server/with-skill.ts`

## Event lifecycle

Each wrapped route emits one of these paths:

1. `api.request.started` (except on the route-scoped paths below)
2. `api.request.completed`
3. `api.request.failed`

## Route-scoped started

`api.request.started` is not emitted for two route families, matched on the
request pathname (never the query) with segment boundaries:

- `/api/auth/session` and `/api/auth/session/`
- `/api/trpc` and anything under `/api/trpc/`

Near-misses such as `/api/auth/sessionfoo`, `/api/auth/session-x`, `/api/trpcx`
and `/api/trpc-other` still emit `started`. Every other route is unchanged,
including auth callbacks and confirmation, `/api/inngest`, checkout and
webhooks. `completed`, `failed_response` and `failed` are unchanged on all
routes, with the same fields and redaction.

On the skipped paths, a hard kill, OOM, timeout or any other loss before the
terminal event (including tRPC progress calls) leaves **no** app-log trace.
Vercel's platform lambda lines are **not** a proven equivalent for fields or
coverage.

## Logged fields

All events include request context fields:

- `requestId`
- `path`
- `method`
- `host`
- `userAgent`
- `referer`
- `clientIp`
- `contentType`
- `contentLength`
- `queryKeys`
- `query`
- `queryString`

Completion/failure events include:

- `durationMs`
- `status` (completion only)
- `ok` (completion only)
- `error` (failure only, serialized)

## Redaction

Query parameter values are redacted when keys match:

`token|secret|password|signature|code|key|auth|jwt|credential|session`

Redacted values are stored as `[REDACTED]` in both `query` and `queryString`.

## Route usage

Wrap exported handlers:

```ts
import { withSkill } from '@/server/with-skill'

const getHandler = async (request: NextRequest) => {
	return NextResponse.json({ ok: true })
}

export const GET = withSkill(getHandler)
```

## Smoke checklist

1. Hit 2-3 wrapped routes (include at least 1 failure).
2. Confirm `api.request.started` and `api.request.completed` for success routes, except `/api/auth/session` and `/api/trpc` paths.
3. On `/api/auth/session` and `/api/trpc` paths, confirm `api.request.completed` is present and `api.request.started` is absent.
4. Confirm `api.request.failed` for failure route.
5. Verify `requestId`, `path`, `method`, `status`, and `durationMs` are present.
6. Verify sensitive query keys are redacted.

## Smoke command

Run the local smoke harness:

```bash
cd apps/ai-hero
set -a && source .env.production.local && set +a
pnpm exec tsx scripts/smoke-api-request-telemetry.ts
```

The script emits telemetry through `withSkill` and tries to query Axiom using the loaded token. It requires `started` only for the non-scoped smoke routes, and checks that a route-scoped path emits `completed` without `started`.
