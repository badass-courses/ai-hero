import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SkillsInstallOptions } from './skills-install-options'

describe('SkillsInstallOptions', () => {
	it('leads with the portable installer and keeps Claude Code secondary', () => {
		const markup = renderToStaticMarkup(<SkillsInstallOptions />)

		const portableCommand = 'npx skills@latest add mattpocock/skills'
		const claudeCommand = 'claude plugins install mattpocock-skills'

		expect(markup).toContain('Get the skills')
		expect(markup).not.toContain('Choose how you want updates')
		expect(markup).toContain('Update later with')
		expect(markup).toContain('npx skills update')
		expect(markup.indexOf(portableCommand)).toBeLessThan(
			markup.indexOf(claudeCommand),
		)
	})
})
