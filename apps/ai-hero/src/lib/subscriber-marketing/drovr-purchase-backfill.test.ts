import { describe, expect, it, vi } from 'vitest'

import {
	runPurchaseBackfill,
	type BackfillPurchase,
	type BackfillPorts,
} from './drovr-purchase-backfill'

const purchase = (n: number): BackfillPurchase => ({
	purchaseId: `purch_${n}`,
	email: `u${n}@example.com`,
	productId: 'product-aicc',
	status: 'Valid',
	totalAmount: '199',
	purchasedAt: '2026-10-27T12:00:00.000Z',
})

function ports(overrides: Partial<BackfillPorts> = {}): BackfillPorts {
	return {
		resolve: async () =>
			new Map([
				['u1@example.com', { status: 'resolved', contactId: 'drv-1' }],
				['u2@example.com', { status: 'missing' }],
				['u3@example.com', { status: 'conflict' }],
				['u4@example.com', { status: 'resolved', contactId: 'drv-4' }],
			]),
		deliver: vi.fn(async () => ({ accepted: 1, rejected: 0 })),
		sleep: vi.fn(async () => undefined),
		...overrides,
	}
}

const all = [1, 2, 3, 4].map(purchase)
const ingestConfig = { ingestUrl: 'https://drovr.test/events', apiKey: 'key' }

describe('runPurchaseBackfill', () => {
	it('counts resolved, missing and conflict and posts nothing by default', async () => {
		const p = ports()

		const counts = await runPurchaseBackfill({
			purchases: all,
			allowWrite: false,
			ports: p,
		})

		expect(counts).toEqual({
			purchases: 4,
			resolved: 2,
			missing: 1,
			conflict: 1,
			posted: 0,
			accepted: 0,
			rejected: 0,
		})
		expect(p.deliver).not.toHaveBeenCalled()
	})

	it('posts only resolved buyers, paced, after the snapshot', async () => {
		const order: string[] = []
		const p = ports({
			writeSnapshot: async (rows) => {
				order.push(`snapshot:${rows.length}`)
			},
			deliver: vi.fn(async (args) => {
				order.push(`post:${args.events[0]!.contactId}`)
				return { accepted: 1, rejected: 0 }
			}),
		})

		const counts = await runPurchaseBackfill({
			purchases: all,
			allowWrite: true,
			ingestConfig,
			ports: p,
		})

		expect(order).toEqual(['snapshot:2', 'post:drv-1', 'post:drv-4'])
		expect(counts).toMatchObject({ posted: 2, accepted: 2, rejected: 0 })
		expect(p.sleep).toHaveBeenCalledTimes(1)
		expect(p.sleep).toHaveBeenCalledWith(500)
	})

	it('writes the same purchase-id key the live path uses', async () => {
		const p = ports()

		await runPurchaseBackfill({
			purchases: [purchase(1)],
			allowWrite: true,
			ingestConfig,
			ports: p,
		})

		const events = (p.deliver as ReturnType<typeof vi.fn>).mock.calls[0]![0]
			.events
		expect(events[0].idempotencyKey).toBe(
			'aihero:ai-hero:purchase.recorded:purchase:purch_1',
		)
	})

	it('keeps what was posted when a later post fails', async () => {
		let calls = 0
		const p = ports({
			deliver: vi.fn(async () => {
				calls += 1
				if (calls === 2) throw new Error('drovr purchase delivery failed')
				return { accepted: 1, rejected: 0 }
			}),
		})
		const counts = {
			purchases: 0,
			resolved: 0,
			missing: 0,
			conflict: 0,
			posted: 0,
			accepted: 0,
			rejected: 0,
		}

		await expect(
			runPurchaseBackfill({
				purchases: all,
				allowWrite: true,
				ingestConfig,
				ports: p,
				counts,
			}),
		).rejects.toThrow('delivery failed')
		expect(counts).toMatchObject({ resolved: 2, posted: 1, accepted: 1 })
	})

	it('throws before posting when resolve is unavailable', async () => {
		const p = ports({
			resolve: async () => {
				throw new Error('unavailable')
			},
		})

		await expect(
			runPurchaseBackfill({
				purchases: all,
				allowWrite: true,
				ingestConfig,
				ports: p,
			}),
		).rejects.toThrow('unavailable')
		expect(p.deliver).not.toHaveBeenCalled()
	})
})
