import { COURSE_SYNC_APPLIED_NOTICE_EVENT } from '@/inngest/events/course-sync-applied-notice'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'

import { AI_HERO_COURSE_SYNC_BINDING } from './types'

const DISPATCH_ATTEMPTS = 3
const DISPATCH_RETRY_DELAY_MS = 250

/**
 * Asking for the notice is deliberately cheap and non-blocking. A caller that
 * moved a run to applied has already done the work that matters, so a Slack
 * outage or a slow narration must not turn its success into an error.
 *
 * The send is retried because a dropped dispatch is permanent silence: the run
 * is already applied, so the next poll is a same-revision no-op and never
 * revisits the notice. Retries cover the transient case. A hard failure is
 * logged and accepted rather than persisted to an outbox, because the applied
 * state is already durable and recoverable by re-sending the event.
 */
export async function requestCourseSyncAppliedNotice(input: {
	controlPlaneRunId: string
	requestedBy: 'operator' | 'poller' | 'backfill'
	bindingId?: string
}): Promise<void> {
	const bindingId = input.bindingId ?? AI_HERO_COURSE_SYNC_BINDING.bindingId
	let lastError: unknown = null

	for (let attempt = 1; attempt <= DISPATCH_ATTEMPTS; attempt++) {
		try {
			await inngest.send({
				name: COURSE_SYNC_APPLIED_NOTICE_EVENT,
				data: {
					bindingId,
					controlPlaneRunId: input.controlPlaneRunId,
					requestedBy: input.requestedBy,
				},
			})
			return
		} catch (error) {
			lastError = error
			if (attempt < DISPATCH_ATTEMPTS) {
				await new Promise((resolve) =>
					setTimeout(resolve, DISPATCH_RETRY_DELAY_MS * attempt),
				)
			}
		}
	}

	// Logging is the last thing between here and a swallowed failure, so its own
	// rejection must not become the caller's error.
	try {
		await log.error('course_sync.applied_notice.dispatch_failed', {
			bindingId,
			controlPlaneRunId: input.controlPlaneRunId,
			attempts: DISPATCH_ATTEMPTS,
			error:
				lastError instanceof Error ? lastError.message : String(lastError),
		})
	} catch {
		// Nothing left to report to.
	}
}
