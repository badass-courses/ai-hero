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
			getCurrentSubscriberFromCookie: {
				useQuery: () => ({ data: undefined }),
			},
		},
	},
}))

vi.mock('@/utils/analytics', () => ({
	track: vi.fn(),
}))

vi.mock('./skills-newsletter-actions', () => ({
	tagSubscriberAsSkills: vi.fn(),
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
		expect(markup).toContain(
			'data-source="skill_page_course:skills-grill-me"',
		)
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
})
