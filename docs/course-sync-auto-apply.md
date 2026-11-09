# Course sync automatic apply

Code-only rollout. Merge and deployment remain operator actions. No production sync, release, rollback or progress mutation is part of this change.

## Staged plan

1. Verify access with synthetic ability fixtures: published undated workshops remain entitlement-scoped; future workshops retain the date gate.
2. Allow workshop creation for release-aware cohort bindings. Publish new workshops in the preview plan, preserve existing workshop release state and binding visibility.
3. Read existing resource progress when evaluating lesson, solution and video parent changes or detaches. Same-parent reorders are not destructive: inserting a lesson shifts positions without losing progress. Return stable hold codes and lesson titles with progress counts. Retain regression and lost-video guards.
4. Keep hold notices and stale reminders on durable notification receipts. After successful hold delivery, dispatch a dedicated Inngest event and sleep until 15 minutes after that delivery. Re-read the run, plan hash and awaiting-apply state before reminding. The 30-minute manifest poll is recovery only, not the alarm clock. Send live notices through the existing applied-notice receipt.
5. Verify policy, poller, entitlement, persistence and notification suites; typecheck. Open a code-only PR. Applying remains a separate approval.

## Lifecycle

The existing poll machine remains authoritative: preview evaluated → applying → succeeded, or preview evaluated → awaiting apply. A held preview stays in awaiting apply until operator action. Notification receipts move from started to succeeded or failed; failed delivery can retry, while succeeded delivery cannot repeat. The stale reminder has its own receipt and does not change apply eligibility. Its durable lifecycle is scheduled → sleeping → rechecked → skipped or claimed → delivered. Inngest owns the sleep; the existing poll machine owns apply/hold.

## Rollback

Revert the code change before deployment. Existing published workshops keep their state on later syncs. No HTTP request or response contract changes, no new progress store, and no progress writes.
