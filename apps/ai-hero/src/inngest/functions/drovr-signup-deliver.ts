import { env } from '@/env.mjs'
import { DROVR_SIGNUP_REQUESTED_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	DrovrSignupRefusedError,
	parseDrovrDoiConfig,
	postDrovrSignup,
} from '@/lib/subscriber-marketing/drovr-doi-signup'
import { log } from '@/server/logger'
import { NonRetriableError } from 'inngest'

/**
 * Records a double opt-in signup with drovr. This function owns the retry
 * (6 attempts with Inngest's backoff); the POST itself does not retry, and
 * drovr is idempotent on the submission id. A permanent refusal (4xx) is
 * logged and ends the run; the reader's page already said to check email.
 */
export const drovrSignupDeliver = inngest.createFunction(
	{
		id: 'drovr-signup-deliver-v1',
		name: 'drovr: record a double opt-in signup',
		retries: 6,
		concurrency: [{ limit: 4 }],
	},
	{ event: DROVR_SIGNUP_REQUESTED_EVENT },
	async ({ event, step }) => {
		const config = parseDrovrDoiConfig(env)
		if (!config) {
			// The signup was taken on the drovr path, so drovr must hear it:
			// retry until the deployment has its drovr config back.
			throw new Error(
				'drovr double opt-in is not configured on this deployment',
			)
		}
		const status = await step.run('post-signup', async () => {
			try {
				return await postDrovrSignup(event.data, config)
			} catch (error) {
				if (error instanceof DrovrSignupRefusedError) {
					await log.error('drovr.signup.refused', {
						contactId: event.data.contactId,
						formId: event.data.formId,
						httpStatus: error.httpStatus,
						reason: error.message,
					})
					throw new NonRetriableError(error.message)
				}
				throw error
			}
		})
		await log.info('drovr.signup.recorded', {
			contactId: event.data.contactId,
			formId: event.data.formId,
			status,
		})
		return { status }
	},
)
