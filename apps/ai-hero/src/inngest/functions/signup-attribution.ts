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
			await sendGA4Event({
				client_id: crypto.randomUUID(),
				user_id: user.id,
				events: [
					{
						name: 'sign_up',
						params: { method: 'email' },
					},
				],
			})

			await log.info('analytics.signup.ga4_sent', {
				userId: user.id,
				email: user.email,
			})

			return { sent: true }
		})

		return { recorded: true, userId: user.id, ga4: ga4Result }
	},
)
