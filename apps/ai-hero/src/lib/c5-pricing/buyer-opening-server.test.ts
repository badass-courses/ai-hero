import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticPolicy } from './synthetic-policy.test-fixture'
const state = vi.hoisted(() => ({
	rows: [] as { fields: Record<string, unknown> }[],
	fail: false,
}))
vi.mock('@/db/schema', () => ({ products: { fields: 'fields', id: 'id' } }))
vi.mock('@/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						if (state.fail) throw new Error('fixture unavailable')
						return state.rows
					},
				}),
			}),
		}),
	},
}))
import { c5OpeningWindow } from './buyer-opening-server'
beforeEach(() => {
	state.rows = [{ fields: {} }]
	state.fail = false
})
describe('fresh product enrollment close', () => {
	it('never extends the policy deadline and respects an earlier product close', async () => {
		const policy = syntheticPolicy()
		const original = await c5OpeningWindow(policy)
		for (const close of [
			'2030-02-01T00:00:00.000Z',
			'2030-04-01T00:00:00.000Z',
		]) {
			state.rows = [{ fields: { closeEnrollment: close } }]
			expect((await c5OpeningWindow(policy))?.closesAt).toBe(
				Math.min(original!.closesAt, Date.parse(close)),
			)
		}
	})
	it('fails closed on a missing product or database failure', async () => {
		state.rows = []
		expect(await c5OpeningWindow(syntheticPolicy())).toBeNull()
		state.fail = true
		expect(await c5OpeningWindow(syntheticPolicy())).toBeNull()
	})
})
