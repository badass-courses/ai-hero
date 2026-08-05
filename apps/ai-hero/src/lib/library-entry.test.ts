import { describe, expect, it } from 'vitest'

import {
	ctaFor,
	overviewHrefFor,
	pickCurrentWorkshop,
	statusFor,
} from './library-entry'

function entry(
	slug: string,
	completed: number,
	total: number,
	overrides: { state?: string; startsAt?: string | null } = {},
) {
	return {
		workshop: {
			slug,
			title: slug,
			state: overrides.state ?? 'published',
			startsAt: overrides.startsAt ?? null,
		},
		progress: { completedLessonsCount: completed, totalLessonsCount: total },
	}
}

const available = (workshop: { state: string }) => workshop.state === 'published'

describe('statusFor', () => {
	it('reads nothing done as not started', () => {
		expect(statusFor(0, 9)).toBe('not-started')
	})

	it('reads some done as in progress', () => {
		expect(statusFor(3, 9)).toBe('in-progress')
	})

	it('reads all done as complete', () => {
		expect(statusFor(9, 9)).toBe('complete')
	})

	it('is not complete when there are no lessons to complete', () => {
		expect(statusFor(0, 0)).toBe('not-started')
	})
})

describe('overviewHrefFor', () => {
	/**
	 * This is what a purchase falls back to when its progress can't be computed,
	 * so getting it wrong turns the safety net into a 404.
	 */
	it('routes each resource type to the page that serves it', () => {
		expect(overviewHrefFor('cohort', 'ai-coding')).toBe('/cohorts/ai-coding')
		expect(overviewHrefFor('workshop', 'claude-code~p9j8f')).toBe(
			'/workshops/claude-code~p9j8f',
		)
		expect(overviewHrefFor('tutorial', 'some-tutorial')).toBe(
			'/workshops/some-tutorial',
		)
		expect(overviewHrefFor('post', 'a-post')).toBe('/a-post')
	})

	it('falls back to the index when there is no slug', () => {
		expect(overviewHrefFor('cohort', null)).toBe('/workshops')
		expect(overviewHrefFor(null, null)).toBe('/workshops')
	})
})

describe('ctaFor', () => {
	it('names the lesson it will open', () => {
		expect(ctaFor('in-progress', 'Permissions', '/l/permissions', '/w')).toEqual(
			{ label: 'Continue: Permissions', href: '/l/permissions' },
		)
		expect(ctaFor('not-started', 'Intro', '/l/intro', '/w')).toEqual({
			label: 'Start: Intro',
			href: '/l/intro',
		})
	})

	it('falls back to the bare verb when the lesson has no title', () => {
		expect(ctaFor('in-progress', null, '/l/x', '/w')?.label).toBe('Continue')
	})

	it('offers a review of something finished', () => {
		expect(ctaFor('complete', 'Anything', '/l/x', '/w')).toEqual({
			label: 'Review',
			href: '/w',
		})
	})

	/**
	 * A card with no action is the dead end this page exists to remove — a
	 * cohort whose workshops have not dropped still has to lead somewhere.
	 */
	it('always offers something, even with no lesson to point at', () => {
		expect(ctaFor('not-started', null, null, '/cohorts/x')).toEqual({
			label: 'View course',
			href: '/cohorts/x',
		})
	})
})

describe('pickCurrentWorkshop', () => {
	it('picks the first unfinished workshop', () => {
		const picked = pickCurrentWorkshop(
			[entry('one', 8, 8), entry('two', 3, 7), entry('three', 0, 5)],
			available,
		)

		expect(picked?.workshop.slug).toBe('two')
	})

	/**
	 * The progress adapter rounds `percentCompleted` UP, so 199 of 200 reports
	 * 100. Reading that instead of the counts skipped the workshop holding the
	 * learner's actual next lesson and left the card pointing at nothing.
	 */
	it('does not treat a nearly-finished workshop as finished', () => {
		const picked = pickCurrentWorkshop(
			[entry('one', 199, 200), entry('two', 0, 5)],
			available,
		)

		expect(picked?.workshop.slug).toBe('one')
	})

	it('skips workshops that have not been released', () => {
		const picked = pickCurrentWorkshop(
			[entry('unreleased', 0, 0, { state: 'draft' }), entry('live', 0, 5)],
			available,
		)

		expect(picked?.workshop.slug).toBe('live')
	})

	it('skips workshops with no lessons yet', () => {
		const picked = pickCurrentWorkshop(
			[entry('empty', 0, 0), entry('live', 0, 5)],
			available,
		)

		expect(picked?.workshop.slug).toBe('live')
	})

	it('returns nothing when every released workshop is finished', () => {
		expect(
			pickCurrentWorkshop([entry('one', 8, 8), entry('two', 5, 5)], available),
		).toBeUndefined()
	})
})
