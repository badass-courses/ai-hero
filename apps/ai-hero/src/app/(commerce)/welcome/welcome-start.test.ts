import { describe, expect, it } from 'vitest'
import { welcomeStart } from './welcome-start'

const now = new Date('2026-10-14T09:00:00Z')
const cohort = (startsAt: string, timezone?: string) => ({
	type: 'cohort',
	resources: [{ resource: { fields: { startsAt, timezone } } }],
})

describe('welcome start', () => {
	it('sends a course buyer to the first resource', () => {
		expect(
			welcomeStart({
				product: { type: 'self-paced' },
				productResources: [{ type: 'workshop', fields: { slug: 'crash-course' } }],
				ownsASeat: true,
				now,
			}),
		).toEqual({ href: '/workshops/crash-course', label: 'Start learning', startsLabel: null })
	})

	it('sends a cohort buyer to the cohort and says when class starts, in its zone', () => {
		expect(
			welcomeStart({
				product: cohort('2026-11-09T16:00:00.000Z', 'America/Los_Angeles'),
				productResources: [{ type: 'cohort', fields: { slug: 'sf-xdy1m' } }],
				ownsASeat: true,
				now,
			}),
		).toEqual({
			href: '/cohorts/sf-xdy1m',
			label: 'Go to your cohort',
			startsLabel: 'Class starts Nov 9 at 8:00 AM PST.',
		})
	})

	it('says start learning once the cohort is under way', () => {
		const start = welcomeStart({
			product: cohort('2026-10-01T16:00:00.000Z'),
			productResources: [{ type: 'cohort', fields: { slug: 'sf-xdy1m' } }],
			ownsASeat: true,
			now,
		})
		expect(start?.label).toBe('Start learning')
		expect(start?.startsLabel).toBeNull()
	})

	it('offers nothing to a buyer of seats for others, a live ticket, or a missing slug', () => {
		const resources = [{ type: 'workshop', fields: { slug: 'crash-course' } }]
		expect(
			welcomeStart({ product: { type: 'self-paced' }, productResources: resources, ownsASeat: false, now }),
		).toBeNull()
		expect(
			welcomeStart({ product: { type: 'live' }, productResources: resources, ownsASeat: true, now }),
		).toBeNull()
		expect(
			welcomeStart({
				product: { type: 'self-paced' },
				productResources: [{ type: 'workshop', fields: {} }],
				ownsASeat: true,
				now,
			}),
		).toBeNull()
	})
})
