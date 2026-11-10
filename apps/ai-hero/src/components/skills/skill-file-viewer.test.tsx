import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
	SKILL_FILE_DIALOG_CLASS,
	SKILL_FILE_SCROLL_CLASS,
	SkillFileContent,
} from './skill-file-viewer'
import { SkillInstallPanel } from './skill-install-panel'

const file = {
	metadata: [
		{ key: 'name', value: 'to-spec' },
		{ key: 'description', value: 'Record decisions' },
	],
	body: '# Process\n\nUse the project vocabulary.',
	sourceUrl:
		'https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md',
}

describe('SkillFileViewer', () => {
	it('overrides the shared narrow dialog and gives the document its own scroll area', () => {
		expect(SKILL_FILE_DIALOG_CLASS).toContain('sm:max-w-4xl')
		expect(SKILL_FILE_DIALOG_CLASS).toContain('sm:w-[90vw]')
		expect(SKILL_FILE_DIALOG_CLASS).toContain('max-h-[90svh]')
		expect(SKILL_FILE_DIALOG_CLASS).toContain('flex-col')
		expect(SKILL_FILE_SCROLL_CLASS).toContain('min-h-0')
		expect(SKILL_FILE_SCROLL_CLASS).toContain('flex-1')
		expect(SKILL_FILE_SCROLL_CLASS).toContain('overflow-y-auto')
		expect(SKILL_FILE_SCROLL_CLASS).toContain('touch-pan-y')
	})

	it('renders a clear on-site viewer control and exact source companion', () => {
		const markup = renderToStaticMarkup(
			<SkillInstallPanel slug="skills-to-spec" skillFile={file} />,
		)

		expect(markup).toContain('Read full SKILL.md')
		expect(markup).toContain(file.sourceUrl)
		expect(markup).toContain('mattpocock/skills')
	})

	it('keeps metadata and markdown body readable in the viewer', () => {
		const markup = renderToStaticMarkup(<SkillFileContent file={file} />)

		expect(markup).toContain('Skill metadata')
		expect(markup).toMatch(/<dt[^>]*>name<\/dt><dd[^>]*>to-spec<\/dd>/)
		expect(markup).toContain('<h1>Process</h1>')
		expect(markup).toContain('Use the project vocabulary.')
	})

	it('leaves the guide panel working when no skill file is available', () => {
		const markup = renderToStaticMarkup(
			<SkillInstallPanel slug="skills-to-spec" skillFile={null} />,
		)

		expect(markup).not.toContain('Read full SKILL.md')
		expect(markup).toContain('Install this skill')
		expect(markup).toContain('https://github.com/mattpocock/skills')
	})
})
