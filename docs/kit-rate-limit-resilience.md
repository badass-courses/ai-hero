# Kit read cache and short write retries

## Subscriber reads

`emailListProvider.getSubscriber` caches Kit subscriber reads by ID for three minutes on each app instance. The cache holds at most 1,000 entries and shares concurrent reads for the same ID. Separate instances do not share entries.

Only a successful subscriber read, including its tags, or a 404 from the subscriber endpoint enters the cache. A failed tags read, 429, other error, or ambiguous empty response does not. A cached 404 returns `null` at the provider boundary. Successful subscription and field writes invalidate the affected ID when known. In-flight reads cannot refill an invalidated entry.

The cache returns the complete subscriber state and fields without changing opt-out values. Consent and unsubscribe decisions must use `getSubscriberFresh` (also exposed on `emailListProvider`) or the uncached email/preference readers, never `getSubscriber`. The preferences identity reader uses `getSubscriberFresh`, so Kit-side changes to unsubscribe tags and subscriber state bypass the three-minute cache. React request memoization remains local to a render/request.

Audited consent and sending paths:

- `lib/email-preferences.ts`: preferences, unsubscribe identity checks, API reads, admin reads, and local preference synchronization share the fresh subscriber reader. `getProviderEmailPreferences` uses Course Builder's uncached `getSubscriberPreferences`.
- `lib/subscriber-marketing/ai-hero-email-opt-in.server.ts`: opt-in reconciliation checks unsubscribe tags using uncached `getSubscriberByEmail`.
- The remaining cached ID readers in `lib/convertkit.ts`, `lib/video-viewer-status-query.ts`, the survey router, the skills subscribe page, and the marketing operator's identity-link preview resolve display, survey, or identity data, not send consent. CTA gating uses cookie/display snapshots; final opt-in reconciliation stays uncached.

## Write retries

The subscription field contract retries only the Kit HTTP call that returned 429. Its calls share a five-second retry budget. Direct attribution field writes and `updateSubscriberFields` use the same policy around their provider operation.

Each refused call gets at most two retries. Without a usable `Retry-After`, delays are 1,000–1,500 ms and 2,000–2,500 ms. A valid `Retry-After` replaces the base delay and receives up to 500 ms of jitter. If that delay exceeds the remaining budget, the operation fails immediately instead of ignoring Kit's requested delay. Non-429 errors are not retried by this policy.

This budget limits added waiting, not the duration of the provider's HTTP requests. The existing durable Inngest retry scheduler remains separate and unchanged.

Each scheduled retry logs `kit.rate_limit.retry`. Exhaustion logs `kit.rate_limit.exhausted`, including the operation, attempt count, HTTP status, and reason. Neither event contains addresses, subscriber IDs, field values, or credentials. The existing subscribe route maps an exhausted subscription refusal to HTTP 429, not 500.

**Known limitation:** sustained throttling can still drop a signup. This change does not durably accept a pending subscription. A separate durable replay must preserve attribution and opt-in reconciliation, use idempotency, and refuse to resubscribe someone who opted out between the initial attempt and replay.

## Review and rollout

There is no new flag. Merging and deploying enables the cache and short retries. Revert the commit to roll back; any cached entries expire within three minutes on surviving instances. This change does not retag existing failures or change opt-out handling.

After deployment, count `kit.rate_limit.retry` and `kit.rate_limit.exhausted` in the application logs. Compare subscriber-ID Kit read volume and subscribe-route 429s under similar traffic. Exhaustion is an upstream refusal, not evidence that the signup was saved.
