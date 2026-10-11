import { describe, expect, it, vi } from 'vitest'
import { createBuyPathLogger } from '@/lib/buy-path/client'
import { createPurchaseWaitLogger } from './post-purchase-telemetry'

describe('purchase waiting telemetry uses the shared helper', () => {
	it('exports the shared factory without a separate logger or transport', () => {
		expect(createPurchaseWaitLogger).toBe(createBuyPathLogger)
		const transport = vi.fn()
		const emit = createPurchaseWaitLogger('cs_test_synthetic', transport)
		emit('client_returned')
		emit('client_polling', { attempt: 0 })
		emit('purchase_visible')
		emit('destination_rendered')
		expect(transport.mock.calls.map(([event]) => event.step)).toEqual([
			'client_returned',
			'client_polling',
			'purchase_visible',
			'destination_rendered',
		])
		expect(transport).toHaveBeenCalledWith(
			expect.objectContaining({
				buyPathId: 'cs_test_synthetic',
				step: 'client_polling',
				attempt: 0,
				outcome: 'ok',
			}),
		)
	})
})
