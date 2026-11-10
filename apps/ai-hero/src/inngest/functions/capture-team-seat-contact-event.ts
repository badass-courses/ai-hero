import { inngest } from '@/inngest/inngest.server'
import { captureTeamSeatBuyerEntitlement } from '@/lib/capture-buyer-entitlement'
import { TEAM_SEAT_REDEMPTION_CREATED_EVENT } from '@coursebuilder/core/events/commerce'

export const captureTeamSeatContactEvent = inngest.createFunction(
	{
		id: 'capture-team-seat-contact-event',
		name: 'Capture Team Seat Buyer Entitlement',
		idempotency: 'event.data.redeemedPurchaseId',
		retries: 3,
	},
	{ event: TEAM_SEAT_REDEMPTION_CREATED_EVENT },
	async ({ event, step }) =>
		step.run('capture team seat buyer entitlement', () =>
			captureTeamSeatBuyerEntitlement(event.data.redeemedPurchaseId),
		),
)
