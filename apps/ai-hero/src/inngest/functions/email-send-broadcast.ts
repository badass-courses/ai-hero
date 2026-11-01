import { EMAIL_SEND_BROADCAST } from '@/inngest/events/email-send-broadcast'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'

export const emailSendBroadcast = inngest.createFunction(
	{
		id: `email-send-broadcast`,
		name: 'Email: Send Broadcast',
	},
	{
		event: EMAIL_SEND_BROADCAST,
	},
	async ({ event }) => {
		// Broadcasts send through drovr: this Resend path never sends, and its
		// BroadcastActor gates consent itself.
		await log.info('email-preferences.broadcast-guard.skipped', {
			source: 'broadcast-guard',
			provider: 'drovr',
			userId: event.data.toUserId,
			result: 'skipped',
			reason: 'broadcasts send through drovr',
		})
		return 'Broadcasts send through drovr'
	},
)
