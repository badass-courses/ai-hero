import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SkillFileContent } from './skill-file-viewer'
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

	it('leaves the guide panel working when no skill file is available', () => {
		const markup = renderToStaticMarkup(
			<SkillInstallPanel slug="skills-to-spec" skillFile={null} />,
		)

		expect(markup).not.toContain('Read full SKILL.md')
		expect(markup).toContain('Install this skill')
		expect(markup).toContain('https://github.com/mattpocock/skills')
	})
})
