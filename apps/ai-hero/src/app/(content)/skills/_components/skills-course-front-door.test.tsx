import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./skills-newsletter-actions', () => ({
	tagSubscriberAsSkills: vi.fn(),
}))

vi.mock('./skills-course-restart-actions', () => ({
	resendSkillsCourseLessonOne: vi.fn(),
}))

import { SkillsCourseConfirmed } from './skills-course-confirmed'

describe('Skills course confirmation', () => {
	it('gives returning learners a direct recovery action', () => {
		const markup = renderToStaticMarkup(
			<SkillsCourseConfirmed variant="returning" />,
		)

		expect(markup).toContain('You’re already enrolled.')
		expect(markup).toContain(
			'If lesson one isn’t in your inbox, send a fresh copy.',
		)
		expect(markup).toContain('Send lesson one again')
		expect(markup).toContain('rounded-[9px]')
		expect(markup).not.toContain('Not getting emails? Reconnect')
	})

	it('confirms that lesson one is on its way after a fresh signup', () => {
		const markup = renderToStaticMarkup(
			<SkillsCourseConfirmed variant="just-enrolled" />,
		)

		expect(markup).toContain('You’re in.')
		expect(markup).toContain('Lesson one is on its way to your inbox.')
	})
})
