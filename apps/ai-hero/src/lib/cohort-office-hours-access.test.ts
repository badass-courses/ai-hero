import { createAppAbility, defineRulesForPurchases } from '@/ability'
import { subject } from '@casl/ability'
import { describe, expect, it } from 'vitest'

type ViewerInput = Parameters<typeof defineRulesForPurchases>[0]

const workshop = subject('Content', { id: 'workshop-1' })
const freeLesson = subject('Content', { id: 'free-lesson' })

function abilityFor(input: Record<string, unknown>) {
	return createAppAbility(
		defineRulesForPurchases(input as unknown as ViewerInput),
	)
}

describe('cohort office-hours workshop access', () => {
	it('grants a normal workshop purchaser protected workshop access', () => {
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
