import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/cld-image', () => ({
	CldImage: ({ alt }: { alt: string }) => <span data-alt={alt} />,
}))

vi.mock('@/components/landing/company-logo-grid', () => ({
	CompanyLogoGrid: () => <div>company logos</div>,
}))

vi.mock('@/components/landing/proof-grid', () => ({
	ProofQuote: ({ children }: { children: React.ReactNode }) => (
		<blockquote>{children}</blockquote>
	),
}))

vi.mock('@/components/subscriber-count', () => ({
	SubscriberCount: () => <>100,000</>,
}))

vi.mock('../../_components/skills-course-confirmed', () => ({
	SkillsCourseConfirmed: () => <p>confirmed</p>,
}))

vi.mock('../../_components/skills-newsletter', () => ({
	Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	StatusView: ({ form }: { form: React.ReactNode }) => <>{form}</>,
	Form: () => <form>course form</form>,
	Privacy: () => <p>privacy</p>,
	TagMeButton: () => <button>start</button>,
}))

import { SkillsSubscribeFrontDoor } from './skills-subscribe-page'

describe('/skills/subscribe copy', () => {
	it('explains the email course location and progression exactly', () => {
		const markup = renderToStaticMarkup(
			<SkillsSubscribeFrontDoor status="show-form" location="test" />,
		)

		expect(markup).toContain('Free seven-lesson email course')
		expect(markup).toContain(
			'This is a seven-lesson email course. Lesson 1 arrives as soon as you sign up. The lesson is the email itself. It will not appear under Courses in your AI Hero account.',
		)
		expect(markup).toContain(
			'Answer the question at the end if you want the next lesson in a few minutes. Otherwise, the next lesson arrives automatically after at least 18 hours.',
		)
		expect(markup).toContain('Each lesson is one skill and one small exercise')
		expect(markup).not.toContain('One practical lesson each day')
		expect(markup).not.toContain('Seven days, then')
	})
})
