import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	formProps: null as Record<string, any> | null,
	push: vi.fn(),
	redirectUrlBuilder: vi.fn(() => '/course-confirmed'),
}))

vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: mocks.push }),
}))

vi.mock('@/convertkit', () => ({
	SubscribeToConvertkitForm: (props: Record<string, any>) => {
		mocks.formProps = props
		return React.createElement(
			'form',
			{ 'data-source': props.fields.source },
			props.actionLabel,
		)
	},
	redirectUrlBuilder: mocks.redirectUrlBuilder,
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			// The CTA now asks the SERVER which ask to draw, because only the
			// server can see the session. `isPending: false` with no data is the
			// settled-but-unknown case, which falls back to `fresh` — what these
			// cases exercise. Leaving `isPending` out would hold the card instead.
			getSkillsCourseCtaState: {
				useQuery: () => ({ data: undefined, isPending: false }),
			},
		},
		// The one-click card invalidates this on success so the nav bar's offer
		// updates with it.
		useUtils: () => ({
			ability: {
				getSkillsCourseCtaState: { invalidate: vi.fn() },
			},
		}),
	},
}))

vi.mock('@/utils/analytics', () => ({
	track: vi.fn(),
}))

vi.mock('./skills-newsletter-actions', () => ({
	tagSubscriberAsSkills: vi.fn(),
}))

vi.mock('./skills-course-restart-actions', () => ({
	resendSkillsCourseLessonOne: vi.fn(),
}))

import { SkillsNewsletterCta } from './skills-newsletter-cta'

describe('SkillsNewsletterCta course variant', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.formProps = null
	})

	it('renders course copy, keeps privacy, and submits placement source', () => {
		const markup = renderToStaticMarkup(
			<SkillsNewsletterCta
				variant="course"
				source="skill_page_course:skills-grill-me"
				heading="Course headline"
				subtitle="Course subtitle"
				forceState="fresh"
			/>,
		)

		expect(markup).toContain('Course headline')
		expect(markup).toContain('Course subtitle')
		expect(markup).toContain('Start the free course')
		expect(markup).toContain('I respect your privacy. Unsubscribe at any time.')
		expect(markup).toContain('data-source="skill_page_course:skills-grill-me"')
		expect(mocks.formProps).toMatchObject({
			formId: 9376133,
			fields: {
				interest: 'skills',
				source: 'skill_page_course:skills-grill-me',
			},
		})
	})

	it('sends an active course signup to the course confirmation flow', () => {
		renderToStaticMarkup(
			<SkillsNewsletterCta
				variant="course"
				source="skill_page_course:skills-handoff"
				forceState="fresh"
			/>,
		)

		mocks.formProps?.onSuccess({ state: 'active' })

		expect(mocks.redirectUrlBuilder).toHaveBeenCalledWith(
			expect.anything(),
			'/confirm',
			{ flow: 'course' },
		)
		expect(mocks.push).toHaveBeenCalledWith('/course-confirmed')
	})

	it('keeps the course card shape for an existing subscriber', () => {
		const markup = renderToStaticMarkup(
			<SkillsNewsletterCta
				variant="course"
				source="skill_page_course:never-run-claude-init"
				forceState="tag-me"
			/>,
		)

		expect(markup).toContain('rounded-xl')
		expect(markup).toContain('Start the free course')
	})

	it('offers already-enrolled readers a one-click restart', () => {
		const markup = renderToStaticMarkup(
			<SkillsNewsletterCta
				variant="course"
				source="skill_page_course:skills-handoff"
				forceState="subscribed"
			/>,
		)

		expect(markup).toContain('Free 7-lesson email course')
		expect(markup).toContain('AI Skills for Real Engineers')
		expect(markup).toContain('already enrolled')
		expect(markup).toContain('Send lesson one again')
		expect(markup).not.toContain('name="email_address"')
	})
})
