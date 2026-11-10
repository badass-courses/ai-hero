import { createAppAbility, defineRulesForPurchases } from '@/ability'
import { cohortAbilityFixture } from '@/ability/test-fixtures/cohort-content-scope'
import { subject } from '@casl/ability'
import { afterEach, describe, expect, it, vi } from 'vitest'

// New sync workshops are published/unlisted, but publication is not an access grant.
describe('new published cohort workshop access', () => {
	afterEach(() => {
		vi.useRealTimers()
	})
	it.each([undefined, '2026-12-09T08:01:00.000Z'])(
		'keeps paid content scoped to the cohort entitlement at startsAt=%s',
		(startsAt) => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
			const fixture = cohortAbilityFixture({
				contentIds: ['requested-workshop'],
				startsAt,
			})
			fixture.module.fields.state = 'published'
			fixture.module.fields.visibility = 'unlisted'
			const read = (user: typeof fixture.input.user) =>
				createAppAbility(defineRulesForPurchases({ ...fixture.input, user }))
			const lesson = subject('Content', { id: fixture.lesson.id })
			expect(read(undefined).can('read', lesson)).toBe(false)
			expect(
				read(undefined).can(
					'read',
					subject('Content', { id: fixture.module.id }),
				),
			).toBe(false)
			expect(
				read({ ...fixture.user, entitlements: [] }).can('read', lesson),
			).toBe(false)
			const unrelated = cohortAbilityFixture({
				contentIds: ['other-cohort-workshop'],
			}).user
			expect(read(unrelated).can('read', lesson)).toBe(false)
			expect(read(fixture.user).can('read', lesson)).toBe(
				startsAt === undefined,
			)
		},
	)
})
