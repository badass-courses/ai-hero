import { describe, expect, it } from 'vitest'

import {
	getTeamCardState,
	getUnlinkedBulkPurchases,
	type TeamCardState,
} from './team-purchases'

// The legacy page rendered a full seat card for every visible purchase.
const legacyCardState = (_input: {
	purchaseStatus: string
	managedByViewer: boolean
	couponActive: boolean
}): TeamCardState => 'active'

const STATUSES = ['Valid', 'Refunded', 'Restricted']

describe('getTeamCardState', () => {
	const expected = (
		purchaseStatus: string,
		managedByViewer: boolean,
		couponActive: boolean,
	): TeamCardState => {
		if (purchaseStatus === 'Refunded') return 'refunded'
		if (!managedByViewer) return 'setting-up'
		if (!couponActive) return 'coupon-inactive'
		return 'active'
	}

	for (const status of STATUSES)
		for (const managed of [true, false])
			for (const couponActive of [true, false])
				it(`${status} managed=${managed} coupon=${couponActive}`, () => {
					const input = {
						purchaseStatus: status,
						managedByViewer: managed,
						couponActive,
					}
					expect(getTeamCardState(input)).toBe(
						expected(status, managed, couponActive),
					)
				})

	it('legacy predicate shows a refunded team as live', () => {
		const input = {
			purchaseStatus: 'Refunded',
			managedByViewer: true,
			couponActive: false,
		}
		expect(legacyCardState(input)).toBe('active')
		expect(getTeamCardState(input)).toBe('refunded')
	})

	it('legacy predicate hides the unlinked buyer behind a live card', () => {
		const input = {
			purchaseStatus: 'Valid',
			managedByViewer: false,
			couponActive: true,
		}
		expect(legacyCardState(input)).toBe('active')
		expect(getTeamCardState(input)).toBe('setting-up')
	})

	it('only the fully healthy purchase offers invites and seats', () => {
		expect(
			getTeamCardState({
				purchaseStatus: 'Restricted',
				managedByViewer: true,
				couponActive: true,
			}),
		).toBe('active')
	})
})

describe('getUnlinkedBulkPurchases', () => {
	const p = (id: string, status = 'Valid', bulkCouponId: string | null = 'c') =>
		({ id, status, bulkCouponId }) as any

	it('keeps owned bulk purchases that no managed organization holds', () => {
		expect(
			getUnlinkedBulkPurchases([p('a'), p('b')], [{ id: 'a' }]).map(
				({ id }) => id,
			),
		).toEqual(['b'])
	})

	it('ignores non-bulk and non-visible statuses', () => {
		expect(
			getUnlinkedBulkPurchases(
				[p('x', 'Valid', null), p('y', 'Banned'), p('z', 'Disputed')],
				[],
			),
		).toEqual([])
	})

	it('shows a refunded unlinked purchase so it can be labelled', () => {
		expect(
			getUnlinkedBulkPurchases([p('r', 'Refunded')], []).map(({ id }) => id),
		).toEqual(['r'])
	})
})
