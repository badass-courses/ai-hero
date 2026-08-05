import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
	CohortNavigation,
	CohortWorkshopNav,
} from '@/lib/cohort-navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cohortNavigation: null as CohortNavigation | null,
	nextResource: null as any,
	parentLessonForSolution: null as any,
}))

vi.mock('./cohort-navigation-provider', () => ({
	useCohortNavigation: () => mocks.cohortNavigation,
}))

vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => ({ id: 'workshop-p9j8f' }),
}))

vi.mock('@/utils/get-adjacent-workshop-resources', () => ({
	getAdjacentWorkshopResources: () => ({
		nextResource: mocks.nextResource,
		prevResource: null,
		isSolutionNext: false,
	}),
}))

vi.mock('@/lib/content-navigation', () => ({
	findParentLessonForSolution: () => mocks.parentLessonForSolution,
}))

import { NextLessonToolbarButton } from './next-lesson-toolbar-button'

function render() {
	return renderToStaticMarkup(
		<NextLessonToolbarButton
			lessonId="lesson-pwt8r"
			moduleSlug="claude-code~p9j8f"
		/>,
	)
}

function workshop(
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

describe('NextLessonToolbarButton', () => {
	beforeEach(() => {
		mocks.nextResource = null
		mocks.parentLessonForSolution = null
		mocks.cohortNavigation = {
			id: 'cohort-m0k0w',
			slug: 'ai-coding-for-real-engineers',
			title: 'AI Coding for Real Engineers',
			workshops: [
				workshop({ id: 'workshop-p9j8f' }),
				workshop({
					id: 'workshop-bfkce',
					title: 'Day 1 Fundamentals',
					slug: 'fundamentals~bfkce',
					firstLesson: {
						slug: 'llm-constraints~z2y87',
						title: 'The Constraints Of LLMs',
					},
				}),
			],
		}
	})

	it('links to the next lesson inside the workshop', () => {
		mocks.nextResource = {
			id: 'lesson-next',
			type: 'lesson',
			fields: { slug: 'next-lesson' },
		}

		const markup = render()

		expect(markup).toContain('Next lesson')
		expect(markup).toContain('href="/workshops/claude-code~p9j8f/next-lesson"')
	})

	/**
	 * A solution routes under its PARENT lesson's slug. Building
	 * `/workshops/{module}/{solutionSlug}` from the raw slug is a 404.
	 */
	it('routes a next solution under its parent lesson', () => {
		mocks.nextResource = {
			id: 'solution-x',
			type: 'solution',
			fields: { slug: 'solution-slug' },
		}
		mocks.parentLessonForSolution = { fields: { slug: 'parent-lesson' } }

		expect(render()).toContain(
			'href="/workshops/claude-code~p9j8f/parent-lesson/solution"',
		)
	})

	it('continues into the next workshop past the last lesson', () => {
		const markup = render()

		expect(markup).toContain('Next workshop')
		expect(markup).toContain(
			'href="/workshops/fundamentals~bfkce/llm-constraints~z2y87"',
		)
	})

	/**
	 * The fallback is gated on there being no next resource AT ALL, not on
	 * failing to resolve its slug: a resource we cannot build a link for still
	 * means there is more of this workshop to come, and offering the next
	 * workshop there would skip it.
	 */
	it('renders nothing when a next resource exists but its slug will not resolve', () => {
		mocks.nextResource = {
			id: 'solution-x',
			type: 'solution',
			fields: { slug: 'solution-slug' },
		}
		mocks.parentLessonForSolution = null

		const markup = render()

		expect(markup).toBe('')
		expect(markup).not.toContain('Next workshop')
	})

	it('renders nothing when the next workshop has not been released', () => {
		mocks.cohortNavigation = {
			...mocks.cohortNavigation!,
			workshops: [
				workshop({ id: 'workshop-p9j8f' }),
				workshop({ id: 'workshop-bfkce', state: 'draft' }),
			],
		}

		expect(render()).toBe('')
	})

	it('renders nothing at the end of a standalone workshop', () => {
		mocks.cohortNavigation = null
		expect(render()).toBe('')
	})
})
