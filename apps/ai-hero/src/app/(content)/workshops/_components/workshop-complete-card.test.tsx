import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
	CohortNavigation,
	CohortWorkshopNav,
} from '@/lib/cohort-navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cohortNavigation: null as CohortNavigation | null,
	workshopId: 'workshop-p9j8f' as string | null,
	percentCompleted: 100 as number,
	cohortCertificateEligible: false as boolean,
}))

vi.mock('next/navigation', () => ({
	useRouter: () => ({ prefetch: () => {} }),
}))

vi.mock('./cohort-navigation-provider', () => ({
	useCohortNavigation: () => mocks.cohortNavigation,
}))

vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () =>
		mocks.workshopId ? { id: mocks.workshopId } : null,
}))

vi.mock('../../_components/cohort-certificate-container', () => ({
	useCohortCertificateEligibility: (cohort: CohortNavigation | null) =>
		Boolean(cohort) && mocks.cohortCertificateEligible,
	CohortCertificateAction: ({ cohort }: { cohort: CohortNavigation }) => (
		<button type="button">Get your {cohort.title} certificate</button>
	),
}))

vi.mock('../../_components/module-progress-provider', () => ({
	useModuleProgress: () => ({
		moduleProgress: { percentCompleted: mocks.percentCompleted },
	}),
}))

import { WorkshopCompleteCard } from './workshop-complete-card'

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

/**
 * The real shape of the cohort in the bug report: "Getting To Know Claude
 * Code" is workshop 2 of 8, and its last lesson (`permissions~pwt8r`) is where
 * the page used to run out of road.
 */
function claudeCodeCohort(
	nextOverrides: Partial<CohortWorkshopNav> = {},
): CohortNavigation {
	return {
		id: 'cohort-m0k0w',
		slug: 'ai-coding-for-real-engineers',
		title: 'AI Coding for Real Engineers',
		workshops: [
			workshop({ id: 'workshop-ubuuc', title: 'Before We Start' }),
			workshop({ id: 'workshop-p9j8f', title: 'Getting To Know Claude Code' }),
			workshop({
				id: 'workshop-bfkce',
				title: 'Day 1 Fundamentals',
				slug: 'fundamentals~bfkce',
				firstLesson: {
					slug: 'llm-constraints~z2y87',
					title: 'The Constraints Of LLMs',
				},
				...nextOverrides,
			}),
		],
	}
}

describe('WorkshopCompleteCard', () => {
	beforeEach(() => {
		mocks.cohortCertificateEligible = false
		mocks.cohortNavigation = claudeCodeCohort()
		mocks.workshopId = 'workshop-p9j8f'
		mocks.percentCompleted = 100
	})

	it('hands off to the next workshop by naming its first lesson', () => {
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)

		expect(markup).toContain('Up next: Day 1 Fundamentals')
		expect(markup).toContain('Start: The Constraints Of LLMs')
		// Straight into the lesson, never the next workshop's landing page.
		expect(markup).toContain(
			'href="/workshops/fundamentals~bfkce/llm-constraints~z2y87"',
		)
	})

	it('places the workshop in the cohort', () => {
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)
		expect(markup).toContain('Workshop 2 of 3 complete')
	})

	it('drops "complete" when the workshop is not finished', () => {
		mocks.percentCompleted = 60
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)

		expect(markup).toContain('Workshop 2 of 3')
		expect(markup).not.toContain('Workshop 2 of 3 complete')
	})

	it('says when an unreleased next workshop unlocks, with no dead CTA', () => {
		mocks.cohortNavigation = claudeCodeCohort({
			startsAt: '2099-06-01T07:01:00.000Z',
			timezone: 'America/Los_Angeles',
		})

		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)

		expect(markup).toContain('Up next: Day 1 Fundamentals')
		expect(markup).toContain('Unlocks June 1, 2099')
		expect(markup).not.toContain('Start: The Constraints Of LLMs')
	})

	it('treats a draft next workshop as unreleased', () => {
		mocks.cohortNavigation = claudeCodeCohort({ state: 'draft' })
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)

		expect(markup).toContain('Not released yet')
		expect(markup).not.toContain('Start: The Constraints Of LLMs')
	})

	it('closes out the cohort at the last workshop', () => {
		mocks.workshopId = 'workshop-bfkce'
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)

		// The apostrophe arrives HTML-escaped from `renderToStaticMarkup`.
		expect(markup).toContain(
			'the last workshop in AI Coding for Real Engineers',
		)
		expect(markup).toContain('href="/cohorts/ai-coding-for-real-engineers"')
	})

	it('offers the cohort certificate once every workshop is done', () => {
		mocks.workshopId = 'workshop-bfkce'
		mocks.cohortCertificateEligible = true
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)
		expect(markup).toContain(
			'Get your AI Coding for Real Engineers certificate',
		)
	})

	it('keeps the certificate off the card mid-cohort', () => {
		mocks.cohortCertificateEligible = true
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)
		expect(markup).not.toContain('certificate')
	})

	it('always offers the way back to the cohort', () => {
		const markup = renderToStaticMarkup(<WorkshopCompleteCard />)
		expect(markup).toContain(
			'All workshops in AI Coding for Real Engineers',
		)
	})

	it('renders nothing for a workshop sold on its own', () => {
		mocks.cohortNavigation = null
		expect(renderToStaticMarkup(<WorkshopCompleteCard />)).toBe('')
	})
})
