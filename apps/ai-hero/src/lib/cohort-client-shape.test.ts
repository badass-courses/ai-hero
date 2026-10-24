import { describe, expect, it } from 'vitest'

import type { Cohort } from './cohort'
import { toClientCohort } from './cohort-client-shape'

const LESSON_BODY = 'LESSON_BODY_SENTINEL'

const cohort = {
	id: 'cohort_1',
	type: 'cohort',
	fields: {
		title: 'A cohort',
		slug: 'a-cohort',
		body: 'SALES_BODY_SENTINEL',
		postPurchaseBody: 'POST_PURCHASE_SENTINEL',
		forTeamsBody: 'TEAMS_SENTINEL',
		state: 'published',
		visibility: 'public',
		timezone: 'America/Los_Angeles',
		startsAt: '2026-11-01T00:00:00.000Z',
		endsAt: '2026-12-01T00:00:00.000Z',
		image: 'https://example.com/i.png',
	},
	resources: [
		{
			resource: {
				id: 'workshop_1',
				fields: { title: 'W', slug: 'w' },
				resources: [
					{
						resource: {
							id: 'sync_lesson_1',
							type: 'lesson',
							fields: { title: 'L', slug: 'l', body: LESSON_BODY },
						},
					},
				],
			},
		},
	],
} as unknown as Cohort

describe('toClientCohort', () => {
	it('keeps no lesson body, nested resources, or body fields', () => {
		const json = JSON.stringify(toClientCohort(cohort))
		expect(json).not.toContain(LESSON_BODY)
		expect(json).not.toContain('SALES_BODY_SENTINEL')
		expect(json).not.toContain('POST_PURCHASE_SENTINEL')
		expect(json).not.toContain('TEAMS_SENTINEL')
		expect(json).not.toContain('sync_lesson_1')
		expect(toClientCohort(cohort).resources).toEqual([])
	})

	it('keeps what the pricing widget and sidebar read', () => {
		const shaped = toClientCohort(cohort)
		expect(shaped.id).toBe('cohort_1')
		expect(shaped.fields).toMatchObject({
			title: 'A cohort',
			slug: 'a-cohort',
			timezone: 'America/Los_Angeles',
			startsAt: '2026-11-01T00:00:00.000Z',
			endsAt: '2026-12-01T00:00:00.000Z',
			image: 'https://example.com/i.png',
		})
	})
})
