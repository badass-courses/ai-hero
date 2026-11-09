import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { cn } from '@coursebuilder/utils/cn'

import {
	SKILL_FILE_DIALOG_BODY_CLASS,
	SKILL_FILE_DIALOG_CLASS,
	SkillFileContent,
} from './skill-file-viewer'
import { SkillInstallPanel } from './skill-install-panel'

const file = {
	frontmatter: 'name: to-spec\ndescription: Record decisions',
	body: '# Process\n\nUse the project vocabulary.',
	sourceUrl:
		'https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md',
}

describe('SkillFileViewer', () => {
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
		expect(markup).toContain('name: to-spec')
		expect(markup).toContain('<h1>Process</h1>')
		expect(markup).toContain('Use the project vocabulary.')
	})

	it('overrides the dialog base width and gives the body a bounded scroll row', () => {
		// Layout part of the @coursebuilder/ui DialogContent base, as rendered on
		// aihero.dev on 2026-11-09. Its `sm:max-w-lg` made the viewer 512px wide.
		const base =
			'fixed left-[50%] top-[50%] z-50 grid translate-x-[-50%] translate-y-[-50%] border shadow-lg duration-200 sm:max-w-lg'
		const merged = cn(base, SKILL_FILE_DIALOG_CLASS).split(' ')

		expect(merged).not.toContain('sm:max-w-lg')
		expect(merged).toContain('sm:max-w-5xl')
		expect(merged).toContain('grid-rows-[auto_minmax(0,1fr)]')
		expect(merged).toContain('overflow-hidden')

		const body = SKILL_FILE_DIALOG_BODY_CLASS.split(' ')
		expect(body).toContain('min-h-0')
		expect(body).toContain('overflow-y-auto')
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
