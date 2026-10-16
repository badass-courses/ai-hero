import { describe, expect, it } from 'vitest'
import { parseCompSeatArgs, parseCompSeatUserIds } from './comp-seat-operator'

const args = [
	'--product-id',
	'test-product',
	'--user-ids',
	'ids.txt',
	'--reason',
	'synthetic comp',
]
describe('comp seat operator arguments (no database import)', () => {
	it('defaults to dry-run and accepts ids-only input', () => {
		expect(parseCompSeatArgs(args).execute).toBe(false)
		expect(
			parseCompSeatUserIds('test-user-b\r\ntest-user-a\ntest-user-b\n'),
		).toEqual(['test-user-a', 'test-user-b'])
	})
	it('requires a hash for execute', () => {
		expect(() => parseCompSeatArgs([...args, '--execute'])).toThrow(
			'PlanMismatch: you',
		)
		expect(
			parseCompSeatArgs([...args, '--execute', '--plan-hash', 'a'.repeat(64)])
				.execute,
		).toBe(true)
	})
	it.each([
		['--unknown'],
		['--reason'],
		['--reason', 'duplicate'],
		['--execute', '--dry-run', '--plan-hash', 'a'.repeat(64)],
	])('refuses ambiguous or invalid options %j', (...extra) => {
		expect(() => parseCompSeatArgs([...args, ...extra])).toThrow(
			/InvalidArguments: you .*Accepted: .*Fix: .*Debug:/,
		)
	})
	it.each(['', 'not an id', 'test-user,another-user', '{"id":"test-user"}'])(
		'refuses records instead of ids (%j)',
		(text) => {
			expect(() => parseCompSeatUserIds(text)).toThrow('InvalidUserIds: you')
		},
	)
})
