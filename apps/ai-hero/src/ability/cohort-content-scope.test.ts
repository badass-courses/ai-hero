import { createAppAbility, defineRulesForPurchases } from '@/ability'
import { subject } from '@casl/ability'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cohortAbilityFixture } from './test-fixtures/cohort-content-scope'

function permissions(options: Parameters<typeof cohortAbilityFixture>[0]) {
	const fixture = cohortAbilityFixture(options)
	const ability = createAppAbility(defineRulesForPurchases(fixture.input))
	return {
		lesson: ability.can('read', subject('Content', { id: fixture.lesson.id })),
		workshop: ability.can(
			'read',
			subject('Content', { id: fixture.module.id }),
		),
		pending: ability.can('read', 'PendingOpenAccess'),
	}
}
describe('cohort lesson contentIds scope', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'))
	})
	afterEach(() => vi.useRealTimers())

	it.each([undefined, '2026-11-09T08:01:00.000Z', '2026-12-09T08:01:00.000Z'])(
		'denies an unrelated cohort holder for a direct lesson at startsAt=%s',
		(startsAt) => {
			expect(
				permissions({ contentIds: ['unrelated-workshop'], startsAt }),
			).toEqual({ lesson: false, workshop: false, pending: false })
		},
	)
	it.each([
		undefined,
		null,
		[],
		'requested-workshop',
		'prefix-requested-workshop-suffix',
		123,
		{},
		[null, 123, {}],
	])('fails closed for malformed or missing contentIds (%j)', (contentIds) => {
		for (const startsAt of [undefined, '2026-12-09T08:01:00.000Z']) {
			expect(permissions({ contentIds, startsAt })).toEqual({
				lesson: false,
				workshop: false,
				pending: false,
			})
		}
	})
	it.each(['direct', 'section'] as const)(
		'keeps owned started %s lessons without requiring a purchase',
		(layout) => {
			expect(
				permissions({
					contentIds: ['requested-workshop'],
					startsAt: '2026-11-09T08:01:00.000Z',
					layout,
				}),
			).toEqual({ lesson: true, workshop: true, pending: false })
		},
	)
	it('keeps an owned future module pending while denying paid lesson read', () => {
		expect(
			permissions({
				contentIds: ['requested-workshop'],
				startsAt: '2026-12-09T08:01:00.000Z',
			}),
		).toEqual({ lesson: false, workshop: true, pending: true })
	})
	it('keeps the section-shaped unrelated module negative control', () => {
		expect(
			permissions({ contentIds: ['unrelated-workshop'], layout: 'section' }),
		).toEqual({ lesson: false, workshop: false, pending: false })
	})
	it('keeps a self-paced workshop entitlement scoped to its descendants', () => {
		expect(
			permissions({
				contentIds: ['requested-workshop'],
				entitlementType: 'workshop-type',
				layout: 'section',
			}),
		).toEqual({ lesson: true, workshop: true, pending: false })
	})
	it.each(['direct', 'section'] as const)(
		'keeps explicitly free %s lessons',
		(layout) => {
			expect(
				permissions({ contentIds: ['unrelated-workshop'], free: true, layout })
					.lesson,
			).toBe(true)
		},
	)
	it.each(['admin', 'reviewer'])('keeps the approved %s role', (role) => {
		expect(
			permissions({ contentIds: ['unrelated-workshop'], roles: [role] }).lesson,
		).toBe(true)
	})
	it('fails closed when the current module has no ID', () => {
		const fixture = cohortAbilityFixture({ contentIds: ['requested-workshop'] })
		fixture.module.id = ''
		const ability = createAppAbility(defineRulesForPurchases(fixture.input))
		expect(
			ability.can('read', subject('Content', { id: fixture.lesson.id })),
		).toBe(false)
		expect(ability.can('read', 'PendingOpenAccess')).toBe(false)
	})

	it('does not let an entitlement from another organization widen access', () => {
		const fixture = cohortAbilityFixture({ contentIds: ['unrelated-workshop'] })
		fixture.user.entitlements?.push({
			type: 'cohort-type',
			expires: null,
			metadata: {
				contentIds: ['another-unrelated-workshop'],
				organizationId: 'organization-b',
			},
		})
		const ability = createAppAbility(defineRulesForPurchases(fixture.input))
		expect(
			ability.can('read', subject('Content', { id: fixture.lesson.id })),
		).toBe(false)
	})
})
