import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	record: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	notify: vi.fn(),
}))
vi.mock('@/coursebuilder/slack-provider', () => ({
	slackProvider: {
		defaultChannelId: 'fixture-ops',
		sendNotification: mocks.notify,
	},
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: { options: { paymentsAdapter: { stripe: {} } } },
}))
vi.mock('@/lib/c5-pricing/purchase-decision', () => ({
	recordC5PurchaseDecision: mocks.record,
}))
vi.mock('@/lib/c5-pricing/purchase-decision-store', () => ({
	drizzleC5DecisionStore: () => ({}),
}))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (_config: unknown, _trigger: unknown, handler: unknown) =>
			handler,
	},
}))
import { c5PurchaseDecision } from './c5-purchase-decision'

type Input = {
	event: { data: { purchaseId: string; checkoutSessionId: string } }
	step: { run: (id: string, run: () => Promise<unknown>) => Promise<unknown> }
}
// SAFETY: the mocked createFunction returns the supplied handler, not an Inngest Function.
const run = c5PurchaseDecision as unknown as (input: Input) => Promise<unknown>
const input: Input = {
	event: { data: { purchaseId: 'p-fixture', checkoutSessionId: 'cs_fixture' } },
	step: { run: async (_id, work) => work() },
}
beforeEach(() => { vi.clearAllMocks() })
describe('C5 decision observability', () => {
	it('alerts a conflicting replay without logging saved', async () => {
		mocks.record.mockResolvedValue({
			status: 'conflict',
			purchaseId: 'p-fixture',
			expectedRef: 'new',
			storedRef: 'original',
		})
		await expect(run(input)).resolves.toMatchObject({ status: 'conflict' })
		expect(mocks.error).toHaveBeenCalledWith(
			'c5.purchase.decision_conflict',
			expect.objectContaining({ storedRef: 'original' }),
		)
		expect(mocks.notify).toHaveBeenCalledTimes(1)
		expect(mocks.info).not.toHaveBeenCalled()
	})
	it('logs saved only after the recorder returns its verified result', async () => {
		mocks.record.mockResolvedValue({
			status: 'saved',
			purchaseId: 'p-fixture',
			verdict: { kind: 'clean' },
		})
		await run(input)
		expect(mocks.info).toHaveBeenCalledWith(
			'c5.purchase.decision',
			expect.objectContaining({ status: 'saved' }),
		)
		expect(mocks.notify).not.toHaveBeenCalled()
	})
	it('propagates failed readback without a success log', async () => {
		mocks.record.mockRejectedValue(
			new Error('purchase-decision-readback-missing'),
		)
		await expect(run(input)).rejects.toThrow(
			'purchase-decision-readback-missing',
		)
		expect(mocks.info).not.toHaveBeenCalled()
	})
})
