import { env } from '@/env.mjs'
import { DROVR_SIGNUP_REQUESTED_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	DrovrSignupRefusedError,
	parseDrovrSignupDeliveryConfig,
	postDrovrSignup,
	type DrovrSignupRequest,
	type DrovrSignupStatus,
} from '@/lib/subscriber-marketing/drovr-doi-signup'
import {
	DROVR_SEND_RETRIES,
	outboxEntryForSignup,
} from '@/lib/subscriber-marketing/drovr-outbox'
import { captureDrovrOutboxLive } from '@/lib/subscriber-marketing/drovr-outbox-live'
import {
	sendOrOutbox,
	type DrovrOutboxCaptureFn,
} from '@/lib/subscriber-marketing/drovr-outbox-step'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'
import { log } from '@/server/logger'
import { NonRetriableError } from 'inngest'

type PostSignupStep =
	| { status: DrovrSignupStatus }
	| { refused: number; reason: string }
	| { outboxed: true }

/**
 * The signup function's onFailure (row 204): a run that died before its
 * post could outbox it. A refusal is final and never outboxed.
 */
export async function outboxFailedSignup(
	request: DrovrSignupRequest,
	error: { name?: string } | undefined,
	capture: DrovrOutboxCaptureFn = captureDrovrOutboxLive,
): Promise<void> {
	if (error?.name === 'NonRetriableError') return
	if (isSyntheticPrincipalId(request.contactId)) return
	try {
		await capture(
			[{ ...outboxEntryForSignup(request), source: 'onFailure' }],
			error,
		)
	} catch (captureError) {
		await log.error('drovr.outbox.on_failure_capture_failed', {
			count: 1,
			error:
				captureError instanceof Error
					? captureError.message
					: String(captureError),
			idempotencyKeys: [request.submissionId],
		})
	}
}

/**
 * Records a double opt-in signup with drovr. This function owns the retry
 * (8 retries, Retry-After honoured over the backoff table); the POST itself
 * does not retry, and drovr is idempotent on the submission id. The last
 * failed attempt hands the signup to the drovr outbox (row 204). A
 * permanent refusal (4xx) is logged and ends the run; the reader's page
 * already said to check email.
 */
export const drovrSignupDeliver = inngest.createFunction(
	{
		id: 'drovr-signup-deliver-v1',
		name: 'drovr: record a double opt-in signup',
		retries: DROVR_SEND_RETRIES,
		concurrency: [{ limit: 4 }],
		onFailure: async ({ event, error }) => {
			await outboxFailedSignup(event.data.event.data, error)
		},
	},
	{ event: DROVR_SIGNUP_REQUESTED_EVENT },
	async ({ event, step, attempt, maxAttempts }) => {
		// A synthetic test principal never reaches drovr, like every other
		// drovr send (withoutSyntheticContacts), so it never reaches the
		// outbox either (row 204b).
		if (isSyntheticPrincipalId(event.data.contactId)) {
			await log.info('drovr.signup.synthetic_skipped', {
				contactId: event.data.contactId,
				formId: event.data.formId,
			})
			return { status: 'skipped' as const, reason: 'synthetic-principal' }
		}
		// Not the intake flag: a queued signup is delivered even after
		// DROVR_DOI_FORMS is turned off.
		const config = parseDrovrSignupDeliveryConfig(env)
		if (!config) {
			// The signup was taken on the drovr path, so drovr must hear it:
			// retry until the deployment has its drovr config back.
			throw new Error(
				'drovr double opt-in is not configured on this deployment',
			)
		}
		const posted = (await step.run('post-signup', () =>
			sendOrOutbox<PostSignupStep>({
				attempt: { attempt, maxAttempts },
				send: async () => {
					try {
						return { status: await postDrovrSignup(event.data, config) }
					} catch (error) {
						if (!(error instanceof DrovrSignupRefusedError)) throw error
						await log.error('drovr.signup.refused', {
							contactId: event.data.contactId,
							formId: event.data.formId,
							httpStatus: error.httpStatus,
							reason: error.message,
						})
						// Final: returned, not thrown, so no retry and no outbox.
						return { refused: error.httpStatus, reason: error.message }
					}
				},
				unsent: () => [outboxEntryForSignup(event.data)],
				capture: captureDrovrOutboxLive,
				outboxed: () => ({ outboxed: true }),
			}),
		)) as PostSignupStep
		if ('refused' in posted) throw new NonRetriableError(posted.reason)
		if ('outboxed' in posted) return { status: 'outboxed' as const }
		const { status } = posted
		await log.info('drovr.signup.recorded', {
			contactId: event.data.contactId,
			formId: event.data.formId,
			status,
		})
		return { status }
	},
)
