import { describe, expect, it, vi } from 'vitest'
const capture = vi.hoisted(() =>
	vi.fn(async (_purchaseId: string) => ({ counts: { written: 1 } })),
)
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
vi.mock('@/lib/capture-buyer-entitlement', () => ({
	captureTeamSeatBuyerEntitlement: capture,
}))
import { captureTeamSeatContactEvent } from './capture-team-seat-contact-event'
it('subscribes to team seat redemption, dedupes by purchase, and durably writes the seat owner fact', async () => {
	const fn = captureTeamSeatContactEvent as unknown as {
		config: unknown
		trigger: unknown
		handler: (input: unknown) => Promise<unknown>
	}
	expect(fn.config).toMatchObject({
		idempotency: 'event.data.redeemedPurchaseId',
	})
	expect(fn.trigger).toEqual({ event: 'team-seat-redemption/created' })
	const run = vi.fn(async (_id: string, work: () => unknown) => work())
	await fn.handler({
		event: {
			data: { redeemedPurchaseId: 'seat-purchase-1', userId: 'not-trusted' },
		},
		step: { run },
	})
	expect(capture).toHaveBeenCalledWith('seat-purchase-1')
})
