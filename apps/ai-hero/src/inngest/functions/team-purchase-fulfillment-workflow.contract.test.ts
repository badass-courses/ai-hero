import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	reconcileTeamPurchaseFulfillment: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
}))

vi.mock('@/config', () => ({ default: {} }))
vi.mock('@/db', () => ({ courseBuilderAdapter: {}, db: {} }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: vi.fn(
			(_config: unknown, _trigger: unknown, handler: unknown) => ({ handler }),
		),
	},
}))
vi.mock('@/lib/team-purchase-fulfillment', () => ({
	reconcileTeamPurchaseFulfillment: mocks.reconcileTeamPurchaseFulfillment,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

import { teamPurchaseFulfillmentWorkflow } from './team-purchase-fulfillment-workflow'

type Event = {
	name: typeof NEW_PURCHASE_CREATED_EVENT
	data: {
		purchaseId: string
		productType: 'self-paced' | 'cohort' | 'live'
		checkoutSessionId: string | null
		invoiceId?: string
		quantity?: number
	}
}

type Handler = (input: {
	event: Event
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
	}
	runId: string
}) => Promise<unknown>

const handler = (teamPurchaseFulfillmentWorkflow as unknown as {
	handler: Handler
}).handler

function event(
	productType: Event['data']['productType'],
	overrides: Partial<Event['data']> = {},
): Event {
	return {
		name: NEW_PURCHASE_CREATED_EVENT,
		data: {
			purchaseId: `purchase-${productType}`,
			productType,
			checkoutSessionId: 'checkout-team',
			quantity: 4,
			...overrides,
		},
	}
}

describe('team purchase fulfillment event coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.reconcileTeamPurchaseFulfillment.mockResolvedValue({
			status: 'linked',
			purchaseId: 'purchase-team',
			bulkCouponId: 'coupon-team',
			organizationId: 'organization-team',
			organizationMembershipId: 'membership-manager',
		})
	})

	it.each([
		{
			name: 'initial bulk checkout',
			event: event('self-paced'),
		},
		{
			name: 'invoice fulfillment',
			event: event('cohort', {
				purchaseId: 'purchase-invoice',
				checkoutSessionId: null,
				invoiceId: 'invoice-team',
				quantity: 9,
			}),
		},
		{
			name: 'live team purchase',
			event: event('live', { purchaseId: 'purchase-live' }),
		},
	])('reconciles $name through the common purchase event', async ({ event }) => {
		const step = {
			run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
				callback(),
			),
		}

		await handler({ event, step, runId: 'run-team-fulfillment' })

		expect(mocks.reconcileTeamPurchaseFulfillment).toHaveBeenCalledOnce()
		expect(mocks.reconcileTeamPurchaseFulfillment).toHaveBeenCalledWith(
			event.data.purchaseId,
		)
		expect(step.run).toHaveBeenCalledWith(
			'reconcile team purchase organization linkage',
			expect.any(Function),
		)
	})
})
