import { describe, expect, it, vi } from 'vitest'

import {
	getTeamCardState,
	getTeamPurchaseLink,
	getUnlinkedBulkPurchases,
	getUnlinkedBulkPurchasesForUser,
	type TeamCardState,
	type TeamPurchaseDataSource,
	type TeamPurchaseLink,
} from './team-purchases'

const STATUSES = [
	'Valid',
	'Restricted',
	'Refunded',
	'Disputed',
	'Banned',
	'Odd',
]
const LINKS: TeamPurchaseLink[] = [
	'managed',
	'no-organization',
	'not-a-manager',
	'no-membership',
]

describe('getTeamCardState table', () => {
	const expected = (
		status: string,
		link: TeamPurchaseLink,
		couponActive: boolean,
	): TeamCardState => {
		if (status === 'Refunded') return 'refunded'
		if (status !== 'Valid' && status !== 'Restricted') return 'unavailable'
		if (link === 'not-a-manager') return 'managed-by-admin'
		if (link === 'no-membership') return 'setting-up'
		return couponActive ? 'active' : 'coupon-inactive'
	}

	for (const status of STATUSES)
		for (const link of LINKS)
			for (const couponActive of [true, false])
				it(`${status} ${link} coupon=${couponActive}`, () => {
					expect(
						getTeamCardState({ purchaseStatus: status, link, couponActive }),
					).toBe(expected(status, link, couponActive))
				})

	it('names the shapes the desk cares about', () => {
		const s = (
			purchaseStatus: string,
			link: TeamPurchaseLink,
			couponActive = true,
		) => getTeamCardState({ purchaseStatus, link, couponActive })
		expect(s('Refunded', 'managed', false)).toBe('refunded')
		// No organization, working coupon: the pool is fine and offers its invite.
		expect(s('Valid', 'no-organization')).toBe('active')
		expect(s('Restricted', 'managed')).toBe('active')
		expect(s('Valid', 'not-a-manager')).toBe('managed-by-admin')
		expect(s('Valid', 'no-membership')).toBe('setting-up')
		for (const status of ['Disputed', 'Banned', 'Odd'])
			expect(s(status, 'managed')).toBe('unavailable')
	})
})

describe('getTeamPurchaseLink', () => {
	it('classifies by organization and membership', () => {
		expect(getTeamPurchaseLink({ organizationId: null }, [])).toBe(
			'no-organization',
		)
		expect(
			getTeamPurchaseLink({ organizationId: 'o1' }, [{ organizationId: 'o1' }]),
		).toBe('not-a-manager')
		expect(
			getTeamPurchaseLink({ organizationId: 'o1' }, [{ organizationId: 'o2' }]),
		).toBe('no-membership')
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

	it('keeps a refunded unlinked purchase so it can be labelled', () => {
		expect(
			getUnlinkedBulkPurchases([p('r', 'Refunded')], []).map(({ id }) => id),
		).toEqual(['r'])
	})
})

describe('getUnlinkedBulkPurchasesForUser', () => {
	const row = (id: string, userId: string, organizationId: string | null) =>
		({
			id,
			userId,
			organizationId,
			status: 'Valid',
			bulkCouponId: `c-${id}`,
		}) as any

	it("filters another user's row even if the repository returns it", async () => {
		const source: TeamPurchaseDataSource = {
			loadMembershipsForUser: vi.fn(async () => []),
			loadBulkPurchasesForOrganizations: vi.fn(async () => []),
			loadBulkPurchasesOwnedByUser: vi.fn(async () => [
				row('mine', 'viewer', null),
				row('theirs', 'someone-else', null),
			]),
		}
		const result = await getUnlinkedBulkPurchasesForUser('viewer', [], source)
		expect(result.map(({ purchase }) => purchase.id)).toEqual(['mine'])
		expect(result[0]?.link).toBe('no-organization')
	})

	it('does nothing for a signed-out viewer and never writes', async () => {
		const source: TeamPurchaseDataSource = {
			loadMembershipsForUser: vi.fn(),
			loadBulkPurchasesForOrganizations: vi.fn(),
			loadBulkPurchasesOwnedByUser: vi.fn(),
		}
		await expect(
			getUnlinkedBulkPurchasesForUser(null, [], source),
		).resolves.toEqual([])
		expect(source.loadBulkPurchasesOwnedByUser).not.toHaveBeenCalled()
		expect(
			Object.keys(source).some((key) =>
				/^(create|insert|update|repair)/.test(key),
			),
		).toBe(false)
	})

	it('classifies a plain member of the holding organization', async () => {
		const source: TeamPurchaseDataSource = {
			loadMembershipsForUser: vi.fn(async () => [
				{ organizationId: 'o1', organizationMembershipRoles: [] },
			]),
			loadBulkPurchasesForOrganizations: vi.fn(async () => []),
			loadBulkPurchasesOwnedByUser: vi.fn(async () => [
				row('handed-off', 'viewer', 'o1'),
				row('no-member', 'viewer', 'o9'),
			]),
		}
		const result = await getUnlinkedBulkPurchasesForUser('viewer', [], source)
		expect(result.map(({ link }) => link)).toEqual([
			'not-a-manager',
			'no-membership',
		])
	})
})
