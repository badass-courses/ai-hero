import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ grant: vi.fn(), error: vi.fn() }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
vi.mock('@/lib/included-product-entitlements', () => ({
	grantIncludedProductEntitlements: mocks.grant,
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.error } }))
import { includedProductEntitlementsRetry } from './included-product-entitlements-retry'

const data = {
	purchaseId: 'seat',
	productId: 'product-s00zs',
	userId: 'learner',
	organizationId: 'personal',
	organizationMembershipId: 'member',
}
// The test transport exposes the registered handler/config instead of a live bus.
const fn = includedProductEntitlementsRetry as unknown as {
	config: {
		retries: number
		onFailure: (args: {
			event: { data: { event: { data: typeof data } } }
		}) => Promise<void>
	}
	handler: (args: {
		event: { data: typeof data }
		step: {
			run: (id: string, work: () => Promise<unknown>) => Promise<unknown>
		}
	}) => Promise<unknown>
}
const run = () =>
	fn.handler({ event: { data }, step: { run: async (_id, work) => work() } })
beforeEach(() => {
	vi.clearAllMocks()
})
it('has an independent retry budget and propagates a failed attempt without customer text in logs', async () => {
	const failure = new Error('private customer text')
	mocks.grant.mockRejectedValueOnce(failure).mockResolvedValueOnce([])
	await expect(run()).rejects.toBe(failure)
	await expect(run()).resolves.toEqual([])
	expect(fn.config.retries).toBe(5)
	expect(mocks.error).toHaveBeenCalledWith('included_product.grant_failed', {
		purchaseId: 'seat',
		productId: 'product-s00zs',
		userId: 'learner',
		status: 'retry_failed',
	})
	expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(
		'private customer text',
	)
})
it('leaves an alertable exhausted-retries signal', async () => {
	await fn.config.onFailure({ event: { data: { event: { data } } } })
	expect(mocks.error).toHaveBeenCalledWith('included_product.grant_failed', {
		purchaseId: 'seat',
		productId: 'product-s00zs',
		userId: 'learner',
		status: 'retries_exhausted',
	})
})
