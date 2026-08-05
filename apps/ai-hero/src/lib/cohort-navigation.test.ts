import { describe, expect, it } from 'vitest'

import {
	getCohortFromNavigation,
	getCohortWorkshopPosition,
	getNextCohortWorkshop,
	isWorkshopAvailable,
	type CohortNavigation,
	type CohortWorkshopNav,
} from './cohort-navigation'
import type { ResourceNavigation } from './content-navigation'

function createWorkshop(
	overrides: Partial<CohortWorkshopNav> & { id: string },
): CohortWorkshopNav {
	return {
		slug: `${overrides.id}-slug`,
		title: `Workshop ${overrides.id}`,
		position: 0,
		state: 'published',
		startsAt: null,
		timezone: 'America/Los_Angeles',
		firstLesson: { slug: 'first-lesson', title: 'First Lesson' },
		...overrides,
	}
}

function createCohortNavigation(
	workshops: CohortWorkshopNav[],
): CohortNavigation {
	return { id: 'cohort-1', slug: 'cohort-slug', title: 'The Cohort', workshops }
}

/**
 * A workshop navigation with a cohort product parent, shaped the way
 * `getContentNavigation` returns it: `parents` are products, and the cohort is
 * one of the product's resources.
 */
function createNavigationWithCohort(
	parents: any[] | undefined,
): ResourceNavigation {
	return {
		id: 'workshop-1',
		type: 'workshop',
		fields: { slug: 'workshop-slug', title: 'A Workshop' },
		parents,
	} as unknown as ResourceNavigation
}

const cohortProduct = {
	type: 'cohort',
	resources: [
		{
			resource: {
				id: 'cohort-1',
				type: 'cohort',
				fields: { slug: 'cohort-slug', title: 'The Cohort' },
			},
		},
	],
}

describe('getCohortFromNavigation', () => {
	it('reads the cohort off a cohort product parent', () => {
		expect(
			getCohortFromNavigation(createNavigationWithCohort([cohortProduct])),
		).toEqual({ id: 'cohort-1', slug: 'cohort-slug', title: 'The Cohort' })
	})

	it('finds the cohort product even when it is not the first parent', () => {
		const selfPacedProduct = {
			type: 'self-paced',
			resources: [
				{
					resource: {
						id: 'workshop-1',
						type: 'workshop',
						fields: { slug: 'workshop-slug', title: 'A Workshop' },
					},
				},
			],
		}

		expect(
			getCohortFromNavigation(
				createNavigationWithCohort([selfPacedProduct, cohortProduct]),
			),
		).toEqual({ id: 'cohort-1', slug: 'cohort-slug', title: 'The Cohort' })
	})

	it('returns null for a workshop sold on its own', () => {
		expect(getCohortFromNavigation(createNavigationWithCohort([]))).toBeNull()
		expect(
			getCohortFromNavigation(createNavigationWithCohort(undefined)),
		).toBeNull()
		expect(getCohortFromNavigation(null)).toBeNull()
	})

	it('returns null when the cohort resource is missing its slug', () => {
		const brokenProduct = {
			type: 'cohort',
			resources: [
				{ resource: { id: 'cohort-1', type: 'cohort', fields: { title: 'X' } } },
			],
		}

		expect(
			getCohortFromNavigation(createNavigationWithCohort([brokenProduct])),
		).toBeNull()
	})
})

describe('isWorkshopAvailable', () => {
	const now = new Date('2026-03-10T12:00:00.000Z')

	it('is available when published with no release date', () => {
		expect(isWorkshopAvailable(createWorkshop({ id: 'w1' }), now)).toBe(true)
	})

	it('is available when its release date has passed', () => {
		const workshop = createWorkshop({
			id: 'w1',
			startsAt: '2026-03-01T00:00:00.000Z',
		})
		expect(isWorkshopAvailable(workshop, now)).toBe(true)
	})

	it('is not available before its release date', () => {
		const workshop = createWorkshop({
			id: 'w1',
			startsAt: '2026-03-12T00:00:00.000Z',
		})
		expect(isWorkshopAvailable(workshop, now)).toBe(false)
	})

	it('is not available while still a draft, even with a past release date', () => {
		const workshop = createWorkshop({
			id: 'w1',
			state: 'draft',
			startsAt: '2026-03-01T00:00:00.000Z',
		})
		expect(isWorkshopAvailable(workshop, now)).toBe(false)
	})

	it('fails open on an unparseable release date', () => {
		const workshop = createWorkshop({ id: 'w1', startsAt: 'not-a-date' })
		expect(isWorkshopAvailable(workshop, now)).toBe(true)
	})
})

describe('getNextCohortWorkshop', () => {
	const navigation = createCohortNavigation([
		createWorkshop({ id: 'w1' }),
		createWorkshop({ id: 'w2' }),
		createWorkshop({ id: 'w3' }),
	])

	it('returns the following workshop in cohort order', () => {
		expect(getNextCohortWorkshop(navigation, 'w1')?.id).toBe('w2')
		expect(getNextCohortWorkshop(navigation, 'w2')?.id).toBe('w3')
	})

	it('returns null at the last workshop', () => {
		expect(getNextCohortWorkshop(navigation, 'w3')).toBeNull()
	})

	it('returns unreleased workshops so the caller can say when they unlock', () => {
		const withDraft = createCohortNavigation([
			createWorkshop({ id: 'w1' }),
			createWorkshop({ id: 'w2', state: 'draft' }),
		])

		expect(getNextCohortWorkshop(withDraft, 'w1')?.id).toBe('w2')
	})

	it('returns null for a workshop that is not in the cohort', () => {
		expect(getNextCohortWorkshop(navigation, 'somewhere-else')).toBeNull()
		expect(getNextCohortWorkshop(null, 'w1')).toBeNull()
		expect(getNextCohortWorkshop(navigation, null)).toBeNull()
	})
})

describe('getCohortWorkshopPosition', () => {
	const navigation = createCohortNavigation([
		createWorkshop({ id: 'w1' }),
		createWorkshop({ id: 'w2' }),
		createWorkshop({ id: 'w3' }),
	])

	it('counts from 1 and includes unreleased workshops in the total', () => {
		expect(getCohortWorkshopPosition(navigation, 'w1')).toEqual({
			index: 1,
			total: 3,
		})
		expect(getCohortWorkshopPosition(navigation, 'w3')).toEqual({
			index: 3,
			total: 3,
		})
	})

	it('returns null for a workshop outside the cohort', () => {
		expect(getCohortWorkshopPosition(navigation, 'nope')).toBeNull()
	})
})
