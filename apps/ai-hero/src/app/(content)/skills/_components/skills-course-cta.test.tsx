import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getSkillsCourseCtaState: {
				useQuery: () => ({ data: undefined, isPending: false }),
			},
		},
		useUtils: () => ({
			ability: {
				getSkillsCourseCtaState: { invalidate: vi.fn() },
			},
		}),
	},
}))

vi.mock('./skills-newsletter-actions', () => ({
	tagSubscriberAsSkills: vi.fn(),
}))

vi.mock('./skills-course-restart-actions', () => ({
	resendSkillsCourseLessonOne: vi.fn(),
}))

import { SkillsCourseCta } from './skills-course-cta'

describe('skill changelog course CTA', () => {
	it('shows course recovery instead of another promotion after enrolment', () => {
		const markup = renderToStaticMarkup(
			<SkillsCourseCta forceState="subscribed" />,
		)

		expect(markup).toContain('Already enrolled in')
		expect(markup).toContain('Send lesson one again')
		expect(markup).not.toContain('Start the course')
	})
})
