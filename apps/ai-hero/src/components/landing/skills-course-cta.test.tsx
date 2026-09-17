import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	formMessage: null as string | null,
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getSkillsCourseCtaState: {
				useQuery: () => ({ data: { state: 'fresh' }, status: 'success' }),
			},
		},
	},
}))

vi.mock('@/app/(content)/skills/_components/skills-newsletter', () => ({
	Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	StatusView: ({ form }: { form: React.ReactNode }) => <>{form}</>,
	Form: () => <form>course form</form>,
	Privacy: ({ formMessage }: { formMessage: string }) => {
		mocks.formMessage = formMessage
		return <p>{formMessage}</p>
	},
	RestartCourse: () => <button>restart</button>,
	TagMeButton: () => <button>start</button>,
}))

import { SkillsCourseCta } from './skills-course-cta'

describe('homepage skills course copy', () => {
	it('explains where lessons live and how the next lesson arrives', () => {
		const markup = renderToStaticMarkup(<SkillsCourseCta status="show-form" />)

		expect(markup).toContain(
			'This is a seven-lesson email course. Lesson 1 arrives as soon as you sign up. The lesson is the email itself. It will not appear under Courses in your AI Hero account.',
		)
		expect(markup).toContain(
			'Answer the question at the end if you want the next lesson in a few minutes. Otherwise, the next lesson arrives automatically after at least 18 hours.',
		)
		expect(mocks.formMessage).toBe(
			"Seven lessons, then you're on the AI Hero list for new skills and Matt's coding letters. Leave any time.",
		)
	})
})
