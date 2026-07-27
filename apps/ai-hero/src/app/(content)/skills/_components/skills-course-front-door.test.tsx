import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SkillsCourseConfirmed } from './skills-course-confirmed'

describe('Skills course confirmation', () => {
	it('reassures confirmed subscribers without requiring a third enrollment click', () => {
		const markup = renderToStaticMarkup(<SkillsCourseConfirmed />)

		expect(markup).toContain('Check your inbox for the first lesson.')
		expect(markup).not.toContain('Start the free course')
		expect(markup).not.toContain('Not getting emails? Reconnect')
	})
})
