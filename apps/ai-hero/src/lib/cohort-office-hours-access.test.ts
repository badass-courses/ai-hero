import { createAppAbility, defineRulesForPurchases } from '@/ability'
import { subject } from '@casl/ability'
import { describe, expect, it } from 'vitest'

type ViewerInput = Parameters<typeof defineRulesForPurchases>[0]

const COHORT_004_WORKSHOP_ID = 'workshop-ubuuc'
const COHORT_004_OFFICE_HOURS_LESSON_ID = 'lesson-3cmbs'

const workshop = subject('Content', { id: 'workshop-1' })
const freeLesson = subject('Content', { id: 'free-lesson' })
const cohort004Workshop = subject('Content', {
	id: COHORT_004_WORKSHOP_ID,
})
const cohort004OfficeHoursLesson = subject('Content', {
	id: COHORT_004_OFFICE_HOURS_LESSON_ID,
})

function abilityFor(input: Record<string, unknown>) {
	return createAppAbility(
		defineRulesForPurchases(input as unknown as ViewerInput),
	)
}

describe('cohort office-hours workshop access', () => {
	it('grants an ordinary Cohort 004 purchaser workshop and office-hours lesson access', () => {
		const ability = abilityFor({
			user: {
				id: 'cohort-004-purchaser',
				roles: [],
				entitlements: [
					{
						// `getAllUserEntitlements` supplies only active rows; a null
						// expiry is an active entitlement with no expiration.
						type: 'cohort-entitlement-type',
						expires: null,
						metadata: { contentIds: [COHORT_004_WORKSHOP_ID] },
					},
				],
			},
			module: {
				id: COHORT_004_WORKSHOP_ID,
				fields: { startsAt: '2026-05-01T08:00:00Z' },
				resources: [
					{
						resourceId: COHORT_004_OFFICE_HOURS_LESSON_ID,
						metadata: {},
						resource: {
							id: COHORT_004_OFFICE_HOURS_LESSON_ID,
							type: 'lesson',
						},
					},
				],
				resourceProducts: [],
			},
			lesson: {
				id: COHORT_004_OFFICE_HOURS_LESSON_ID,
				type: 'lesson',
			},
			entitlementTypes: [
				{
					id: 'cohort-entitlement-type',
					name: 'cohort_content_access',
				},
			],
			allModuleResourceIds: [COHORT_004_OFFICE_HOURS_LESSON_ID],
		})

		expect(ability.can('read', cohort004Workshop)).toBe(true)
		expect(ability.can('read', cohort004OfficeHoursLesson)).toBe(true)
	})

	it('keeps self-paced workshop purchaser access covered', () => {
		const ability = abilityFor({
			user: {
				id: 'purchaser-1',
				roles: [],
				entitlements: [
					{
						type: 'workshop-entitlement-type',
						metadata: { contentIds: ['workshop-1'] },
					},
				],
			},
			module: {
				id: 'workshop-1',
				fields: {},
				resources: [],
				resourceProducts: [],
			},
			entitlementTypes: [
				{
					id: 'workshop-entitlement-type',
					name: 'workshop_content_access',
				},
			],
			allModuleResourceIds: ['free-lesson'],
		})

		expect(ability.can('read', workshop)).toBe(true)
	})

	it('lets an anonymous viewer read a free lesson without granting workshop access', () => {
		const ability = abilityFor({
			module: {
				id: 'workshop-1',
				fields: {},
				resourceProducts: [],
				resources: [
					{
						resourceId: 'free-lesson',
						metadata: { tier: 'free' },
						resource: { id: 'free-lesson', type: 'lesson' },
					},
				],
			},
			lesson: { id: 'free-lesson', type: 'lesson' },
			entitlementTypes: [],
			allModuleResourceIds: ['free-lesson'],
		})

		expect(ability.can('read', freeLesson)).toBe(true)
		expect(ability.can('read', workshop)).toBe(false)
	})

	it.each(['admin', 'reviewer'])('%s can read the protected workshop', (role) => {
		const ability = abilityFor({
			user: {
				id: `${role}-1`,
				roles: [{ name: role }],
				entitlements: [],
			},
			module: {
				id: 'workshop-1',
				fields: {},
				resources: [],
				resourceProducts: [],
			},
			entitlementTypes: [],
			allModuleResourceIds: [],
		})

		expect(ability.can('read', workshop)).toBe(true)
	})
})
