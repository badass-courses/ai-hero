# API Request Telemetry (`withSkill`)

`withSkill` is the request-level telemetry wrapper for Next.js API routes in AI Hero.

Source: `apps/ai-hero/src/server/with-skill.ts`

## Event lifecycle

Each wrapped route emits one of these paths:

1. `api.request.started`
2. `api.request.completed`
3. `api.request.failed`

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
2. Confirm `api.request.started` and `api.request.completed` for success routes.
3. Confirm `api.request.failed` for failure route.
4. Verify `requestId`, `path`, `method`, `status`, and `durationMs` are present.
5. Verify sensitive query keys are redacted.

## Smoke command

Run the local smoke harness:

```bash
cd apps/ai-hero
set -a && source .env.production.local && set +a
pnpm exec tsx scripts/smoke-api-request-telemetry.ts
```

The script emits telemetry through `withSkill` and tries to query Axiom using the loaded token.
