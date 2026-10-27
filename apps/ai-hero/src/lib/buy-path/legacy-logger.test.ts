import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	original: vi.fn(),
	info: vi.fn(),
	emit: vi.fn(),
}))
vi.mock('@coursebuilder/utils/logger', () => {
	const logger = { info: mocks.original }
	return {
		logger,
		setLogger: (methods: Record<string, unknown>) =>
			Object.assign(logger, methods),
	}
})
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
vi.mock('./server', () => ({ emitBuyPath: mocks.emit }))
import { logger } from '@coursebuilder/utils/logger'
import { installBuyPathLegacyAliases } from './legacy-logger'
import {
	recordCheckoutDecision,
	withCheckoutTelemetry,
} from './checkout-context'
describe('legacy aliases and request correlation', () => {
	it('preserves original output and adds identifier-only structured aliases', () => {
		installBuyPathLegacyAliases()
		installBuyPathLegacyAliases()
		logger.info('purchase.completed', {
			checkoutSessionId: 'cs_test_fixture',
			purchaseId: 'purchase_fixture',
			userId: 'user_fixture',
			productId: 'product_fixture',
			email: 'synthetic@example.test',
			productName: 'Synthetic course',
		})
		expect(mocks.original).toHaveBeenCalledOnce()
		expect(mocks.info).toHaveBeenCalledWith(
			'purchase.completed',
			expect.objectContaining({ checkoutSessionId: 'cs_test_fixture' }),
		)
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(
			'synthetic@example.test',
		)
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(
			'Synthetic course',
		)
		expect(mocks.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				buyPathId: 'cs_test_fixture',
				purchaseId: 'purchase_fixture',
			}),
			'purchase_created',
		)
		logger.info('other.event', { email: 'synthetic@example.test' })
		expect(mocks.info).toHaveBeenCalledOnce()
	})
	it('isolates overlapping authoritative decisions without a global current buyer', async () => {
		const results = await Promise.all([
			withCheckoutTelemetry('pre_first', async () => {
				await Promise.resolve()
				expect(recordCheckoutDecision('priced')).toBe('pre_first')
				return 1
			}),
			withCheckoutTelemetry('pre_second', async () => {
				await Promise.resolve()
				expect(recordCheckoutDecision('bounded')).toBe('pre_second')
				return 2
			}),
		])
		expect(results).toEqual([
			{ value: 1, decisionKind: 'priced' },
			{ value: 2, decisionKind: 'bounded' },
		])
		expect(recordCheckoutDecision('priced')).toBeNull()
	})
})
