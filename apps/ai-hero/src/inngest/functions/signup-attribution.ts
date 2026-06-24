import { USER_CREATED_EVENT } from '@/inngest/events/user-created'
import { inngest } from '@/inngest/inngest.server'
import { sendGA4Event } from '@/lib/ga4-measurement'
import { log } from '@/server/logger'

export const signupAttribution = inngest.createFunction(
	{
		id: 'signup-attribution',
		name: 'Record Signup Attribution',
		idempotency: 'event.user.id',
	},
	{ event: USER_CREATED_EVENT },
	async ({ event, step }) => {
		const user = event.user
		if (!user?.id || !user?.email) {
			return { skipped: true, reason: 'No user id or email' }
		}

		const ga4Result = await step.run('emit-ga4-signup', async () => {
			const ga4 = await sendGA4Event({
				client_id: crypto.randomUUID(),
				user_id: user.id,
				events: [
					{
						name: 'sign_up',
						params: { method: 'email', client_id_source: 'generated' },
					},
				],
			})

			await log.info('analytics.signup.ga4_receipt', {
				userId: user.id,
				status: ga4.status,
				eventNames: ga4.eventNames,
				eventCount: ga4.eventCount,
				httpStatus: ga4.httpStatus,
				reason: ga4.reason,
				clientIdSource: 'generated',
			})

			return { ...ga4, clientIdSource: 'generated' }
		})

		return { recorded: true, userId: user.id, ga4: ga4Result }
	},
)
