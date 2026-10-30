import { describe, expect, it } from 'vitest'

import { cohortMoment, upNext } from './cohort-buyer-strip'

const TZ = 'America/Los_Angeles'
const START = '2026-11-09T16:00:00.000Z'
const END = '2026-11-20T23:00:00.000Z'

describe('cohortMoment', () => {
	it('counts calendar days to the start in the cohort zone', () => {
		expect(cohortMoment(START, END, TZ, new Date('2026-10-30T12:00:00Z'))).toEqual({
			phase: 'before',
			days: 10,
		})
	})
	it('says today on the morning of the start', () => {
		expect(cohortMoment(START, END, TZ, new Date('2026-11-09T15:00:00Z'))).toEqual({
			phase: 'before',
			days: 0,
		})
	})
	it('gives the week of a two-week cohort while it runs', () => {
		expect(cohortMoment(START, END, TZ, new Date('2026-11-10T12:00:00Z'))).toEqual({
			phase: 'during',
			week: 1,
			weeks: 2,
		})
		expect(cohortMoment(START, END, TZ, new Date('2026-11-17T12:00:00Z'))).toEqual({
			phase: 'during',
			week: 2,
			weeks: 2,
		})
	})
	it('never runs past the last week before the end', () => {
		expect(cohortMoment(START, END, TZ, new Date('2026-11-20T20:00:00Z'))).toMatchObject({
			week: 2,
			weeks: 2,
		})
	})
	it('is over after the end', () => {
		expect(cohortMoment(START, END, TZ, new Date('2026-11-21T12:00:00Z'))).toEqual({
			phase: 'after',
		})
	})
})

const workshop = (slug: string, state = 'published', startsAt?: string) =>
	({ fields: { slug, title: slug.toUpperCase(), state, startsAt } }) as any
const progress = (done: number, total: number, lesson?: { slug: string; title: string }) =>
	({
		completedLessonsCount: done,
		totalLessonsCount: total,
		nextResource: lesson ? { fields: lesson } : null,
	}) as any
const NOW = new Date('2026-10-30T12:00:00Z')

describe('upNext', () => {
	it('picks the next lesson in the first open workshop with lessons left', () => {
		expect(
			upNext(
				[workshop('prep'), workshop('week-1')],
				[progress(2, 7, { slug: 'repo-setup', title: 'Repo Setup' }), progress(0, 5)],
				NOW,
			),
		).toEqual({
			workshop: 'PREP',
			lesson: 'Repo Setup',
			done: 2,
			total: 7,
			href: '/workshops/prep/repo-setup',
		})
	})
	it('skips finished and locked workshops', () => {
		const next = upNext(
			[workshop('prep'), workshop('locked', 'published', '2026-11-09T16:00:00Z'), workshop('draft', 'draft'), workshop('open')],
			[progress(7, 7), progress(0, 5), progress(0, 5), progress(1, 4)],
			NOW,
		)
		expect(next?.href).toBe('/workshops/open')
	})
	it('is null when every open workshop is done', () => {
		expect(upNext([workshop('prep')], [progress(7, 7)], NOW)).toBeNull()
	})
})

describe('upNext with id-only progress', () => {
	it('finds the lesson title and slug in the workshop tree, inside a section', () => {
		const prep = {
			fields: { slug: 'prep', title: 'Prep', state: 'published' },
			resources: [
				{ resource: { id: 'section-1', fields: { title: 'Setup' }, resources: [
					{ resource: { id: 'lesson-3', fields: { slug: 'repo-setup', title: 'Repo Setup' } } },
				] } },
			],
		} as any
		const next = upNext(
			[prep],
			[{ completedLessonsCount: 2, totalLessonsCount: 7, nextResource: { id: 'lesson-3' } } as any],
			NOW,
		)
		expect(next).toMatchObject({ lesson: 'Repo Setup', href: '/workshops/prep/repo-setup' })
	})
})
