import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	CHECK_TIMEOUT_MS,
	CheckoutStatusSchema,
	createPurchaseWaitMachine,
} from './purchase-wait-machine'

// Drive the same actor the poller uses, including cancellation and deadlines.
describe('purchase waiting lifecycle', () => {
	afterEach(() => {
		vi.useRealTimers()
	})
	it('stops polling at timeout and retries with a fresh deadline', async () => {
		vi.useFakeTimers()
		const check = vi.fn(async () => ({ status: 'processing' as const }))
		const actor = createActor(createPurchaseWaitMachine({ check })).start()
		await vi.advanceTimersByTimeAsync(10001)
		expect(actor.getSnapshot().context.slow).toBe(true)
		await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 10001)
		expect(actor.getSnapshot().matches('failed')).toBe(true)
		const calls = check.mock.calls.length
		await vi.advanceTimersByTimeAsync(10000)
		expect(check).toHaveBeenCalledTimes(calls)
		actor.send({ type: 'RETRY' })
		await vi.advanceTimersByTimeAsync(1)
		expect(actor.getSnapshot().matches('checking')).toBe(true)
		expect(actor.getSnapshot().context.slow).toBe(false)
		actor.stop()
	})
	it('cancels a stalled request at the deadline', async () => {
		vi.useFakeTimers()
		let signal: AbortSignal | undefined
		const actor = createActor(
			createPurchaseWaitMachine({
				check: (_attempt, s) => {
					signal = s
					return new Promise(() => {})
				},
			}),
		).start()
		await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
		expect(actor.getSnapshot().matches('failed')).toBe(true)
		expect(signal?.aborted).toBe(true)
		actor.stop()
	})
	it('enters ready once and emits purchase-visible only after DB evidence', async () => {
		vi.useFakeTimers()
		const emit = vi.fn()
		const actor = createActor(
			createPurchaseWaitMachine({
				check: async () => ({
					status: 'ready',
					purchaseId: 'synthetic-purchase',
					product: { name: 'Synthetic course', image: null },
				}),
				logger: emit,
			}),
		).start()
		await vi.advanceTimersByTimeAsync(1)
		expect(actor.getSnapshot().matches('ready')).toBe(true)
		expect(emit.mock.calls.map(([step]) => step)).toEqual([
			'client_polling',
			'purchase_visible',
		])
		await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
		expect(actor.getSnapshot().matches('ready')).toBe(true)
	})
	it('rejects the unreachable Stripe-failure status: a DB miss cannot prove payment failure', () => {
		expect(
			CheckoutStatusSchema.safeParse({
				status: 'payment_succeeded_processing_failed',
			}).success,
		).toBe(false)
		expect(CheckoutStatusSchema.parse({ status: 'processing' })).toEqual({
			status: 'processing',
		})
	})
	it('stops at a provider error without later requests', async () => {
		vi.useFakeTimers()
		const check = vi.fn(async () => ({
			status: 'error' as const,
			message: 'Try again',
		}))
		const actor = createActor(createPurchaseWaitMachine({ check })).start()
		await vi.advanceTimersByTimeAsync(1)
		expect(actor.getSnapshot().matches('failed')).toBe(true)
		expect(actor.getSnapshot().context.message).toBe('Try again')
		await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
		expect(check).toHaveBeenCalledTimes(1)
		actor.stop()
	})
})
