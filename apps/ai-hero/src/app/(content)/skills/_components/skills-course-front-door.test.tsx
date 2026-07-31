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
	it('reassures confirmed subscribers and offers a no-email restart', () => {
		const markup = renderToStaticMarkup(<SkillsCourseConfirmed />)

		expect(markup).toContain('Check your inbox for the first lesson.')
		expect(markup).toContain('Send lesson one again')
		expect(markup).not.toContain('Not getting emails? Reconnect')
	})
})
