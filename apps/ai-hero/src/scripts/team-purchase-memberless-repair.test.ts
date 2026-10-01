import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {}, closeDatabasePool: vi.fn() }))
import { parseMemberlessRepairArgs } from './team-purchase-memberless-repair'

const base = [
	'--purchase-id',
	'synthetic-purchase',
	'--receipt',
	'/tmp/private-synthetic-receipt.json',
]
describe('memberless repair command guards', () => {
	it('defaults to zero-write preview for exactly one purchase, without historical env IDs', () => {
		expect(parseMemberlessRepairArgs(base)).toMatchObject({
			allowWrite: false,
			purchaseId: 'synthetic-purchase',
			confirmCount: null,
		})
	})
	it('requires the exact plan hash, private plan file, count and write flag', () => {
		expect(
			parseMemberlessRepairArgs([
				...base,
				'--allow-write',
				'--plan',
				'/tmp/private-plan.json',
				'--approved-plan-hash',
				'a'.repeat(64),
				'--confirm-count',
				'1',
			]),
		).toMatchObject({ allowWrite: true, confirmCount: 1 })
	})
	it.each(
		[
			[...base, '--allow-write'],
			[
				...base,
				'--allow-write',
				'--plan',
				'/tmp/private-plan.json',
				'--approved-plan-hash',
				'a'.repeat(64),
				'--confirm-count',
				'2',
			],
			[...base, '--purchase-id', 'second-purchase'],
			[...base, '--allow-write', '--dry-run'],
			[...base, '--plan', '/tmp/private-plan.json'],
			[
				'--purchase-id',
				'synthetic-purchase',
				'--receipt',
				'tracked-receipt.json',
			],
		].map((argv) => ({ argv })),
	)('rejects unsafe or ambiguous arguments %j', ({ argv }) => {
		expect(() => parseMemberlessRepairArgs(argv)).toThrow()
	})
})
