import { expect, it } from 'vitest'
import {
	profileVersionBump,
	BULK_EVENTS_PER_MINUTE,
	BULK_EVENT_INTERVAL_MS,
	RESTATEMENT_CONTACTS_PER_TICK,
	requireBackfillCanary,
	restatementPlan,
} from './contact-sync-deltas'

it('profile-version store decisions distinguish content changes from independent facts', () => {
	for (const old of [undefined, 'a', 'b'])
		for (const next of ['a', 'b']) {
			expect(
				profileVersionBump({
					kind: 'profile-change',
					previousHash: old,
					nextHash: next,
				}),
			).toBe(old !== next)
			expect(
				profileVersionBump({
					kind: 'coupon-issued',
					previousHash: old,
					nextHash: next,
				}),
			).toBe(false)
			expect(
				profileVersionBump({
					kind: 'restate',
					previousHash: old,
					nextHash: next,
				}),
			).toBe(false)
		}
})
it('refuses unsafe approval shapes terminally; a boolean cursor is not a canary grant', () => {
	for (const input of [
		{},
		{ canary: true },
		{
			canary: true,
			dryRunCount: 0,
			canaryConfirmed: true,
			cursor: { phase: 'owners' },
		},
	])
		expect(() => requireBackfillCanary(input)).toThrow(
			expect.objectContaining({ name: 'NonRetriableError' }),
		)
	expect(() =>
		requireBackfillCanary({ canary: true, dryRunCount: 3 }),
	).not.toThrow()
})
it('uses the measured 100/minute cap and preserves conservative monthly headroom', () => {
	expect(BULK_EVENTS_PER_MINUTE).toBe(100)
	expect(BULK_EVENT_INTERVAL_MS).toBe(600)
	expect(RESTATEMENT_CONTACTS_PER_TICK).toBe(133)
	expect(restatementPlan(383040, 0).contacts).toBe(133)
})
it('fails capacity terminally instead of silently stretching a monthly rotation', () => {
	expect(
		restatementPlan(2881, Date.parse('2032-02-05T00:00:00.000Z')).contacts,
	).toBe(2)
	expect(() => restatementPlan(133 * 30 * 24 * 4 + 1, 0)).toThrow(
		expect.objectContaining({ name: 'NonRetriableError' }),
	)
})
