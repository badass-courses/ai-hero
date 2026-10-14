import { subject } from '@casl/ability'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createAppAbility,
	defineRulesForPurchases,
	cohortModuleOpenFor,
} from './index'
import { cohortAbilityFixture } from './test-fixtures/cohort-content-scope'

const now = new Date('2026-11-10T00:00:00.000Z')
afterEach(() => {
	vi.useRealTimers()
})

describe('cohort early access properties', () => {
	it('pure decision keeps the flag and module boundaries across dates', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(true, 'true', 1, undefined, false),
				fc.option(fc.integer({ min: -1000000000, max: 1000000000 }), {
					nil: undefined,
				}),
				fc.boolean(),
				(earlyAccess, offset, owned) => {
					const startsAt =
						offset === undefined
							? undefined
							: new Date(now.getTime() + offset).toISOString()
					expect(
						cohortModuleOpenFor(
							{
								type: 'cohort-type',
								metadata: {
									earlyAccess,
									contentIds: [owned ? 'requested-workshop' : 'other-workshop'],
								},
							},
							{ id: 'requested-workshop', fields: { startsAt } },
							now,
						),
					).toBe(
						owned &&
							(earlyAccess === true || offset === undefined || offset < 0),
					)
				},
			),
			{ seed: 5418, numRuns: 500 },
		)
	})
	it('only strict true removes the date gate, never the module scope', () => {
		vi.useFakeTimers()
		vi.setSystemTime(now)
		fc.assert(
			fc.property(
				fc.constantFrom(true, 'true', 1, undefined, false),
				fc.integer({ min: -1000000000, max: 1000000000 }),
				fc.boolean(),
				fc.constantFrom('direct' as const, 'section' as const),
				(earlyAccess, offset, owned, layout) => {
					const fixture = cohortAbilityFixture({
						contentIds: [owned ? 'requested-workshop' : 'other-workshop'],
						startsAt: new Date(now.getTime() + offset).toISOString(),
						layout,
					})
					fixture.user.entitlements![0]!.metadata.earlyAccess = earlyAccess
					const ability = createAppAbility(
						defineRulesForPurchases(fixture.input),
					)
					const open = earlyAccess === true || offset < 0
					expect(
						ability.can('read', subject('Content', { id: fixture.lesson.id })),
					).toBe(owned && open)
					expect(ability.can('read', 'PendingOpenAccess')).toBe(owned && !open)
				},
			),
			{ seed: 5417, numRuns: 500 },
		)
	})
	it.each([true, 'true', 1, undefined, false])(
		'preserves the exact start boundary for %j',
		(earlyAccess) => {
			vi.useFakeTimers()
			vi.setSystemTime(now)
			const fixture = cohortAbilityFixture({
				contentIds: ['requested-workshop'],
				startsAt: now.toISOString(),
			})
			fixture.user.entitlements![0]!.metadata.earlyAccess = earlyAccess
			const ability = createAppAbility(defineRulesForPurchases(fixture.input))
			expect(
				ability.can('read', subject('Content', { id: fixture.lesson.id })),
			).toBe(earlyAccess === true)
		},
	)
})
