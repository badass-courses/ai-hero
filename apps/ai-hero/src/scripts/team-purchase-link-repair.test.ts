import { describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({ default: {} }))
vi.mock('@/db', () => ({
	closeDatabasePool: vi.fn(),
	db: { query: { purchases: { findFirst: vi.fn() } } },
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/lib/team-purchases', () => ({
	getTeamPurchasesForMember: vi.fn(),
}))

import { parseRepairArgs } from './team-purchase-link-repair'

describe('bounded team purchase link repair arguments', () => {
	const approvedIds = ['purchase-one', 'purchase-two']

	it('requires an explicit purchase allowlist', () => {
		expect(() => parseRepairArgs([], approvedIds)).toThrow(
			'At least one --purchase-id is required',
		)
	})

	it('defaults to dry-run and deduplicates the allowlist', () => {
		expect(
			parseRepairArgs([
				'--purchase-id',
				'purchase-one',
				'--purchase-id=purchase-one',
				'--receipt',
				'/tmp/receipt.json',
			], approvedIds),
		).toEqual({
			purchaseIds: ['purchase-one'],
			allowWrite: false,
			confirmCount: null,
			receiptPath: '/tmp/receipt.json',
		})
	})

	it('refuses any purchase outside the two configured historical cases', () => {
		expect(() =>
			parseRepairArgs(
				['--purchase-id=unapproved-purchase'],
				approvedIds,
			),
		).toThrow('Purchase allowlist contains an unapproved ID')
	})

	it('refuses writes unless confirm-count exactly matches the allowlist', () => {
		expect(() =>
			parseRepairArgs([
				'--purchase-id=purchase-one',
				'--purchase-id=purchase-two',
				'--allow-write',
				'--confirm-count',
				'1',
			], approvedIds),
		).toThrow(
			'--allow-write requires --confirm-count to match the purchase allowlist',
		)
	})

	it('accepts an exact confirmed allowlist for a separately approved write', () => {
		expect(
			parseRepairArgs([
				'--purchase-id=purchase-one',
				'--purchase-id=purchase-two',
				'--allow-write',
				'--confirm-count',
				'2',
			], approvedIds),
		).toMatchObject({
			purchaseIds: ['purchase-one', 'purchase-two'],
			allowWrite: true,
			confirmCount: 2,
		})
	})
})
