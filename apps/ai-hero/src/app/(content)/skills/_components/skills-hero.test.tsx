import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-stars-query', () => ({
	getRepoStarCount: vi.fn(),
}))

import { SkillsHero } from './skills-hero'

describe('SkillsHero', () => {
	it('shows the live Skills.sh badge in the aligned fact row', async () => {
		const hero = await SkillsHero({ stars: 195_379, skillCount: 49 })
		const markup = renderToStaticMarkup(hero)

		expect(markup).toContain('195,379')
		expect(markup).toContain('Total skill installs')
		expect(markup).toContain('https://www.skills.sh/b/mattpocock/skills')
		expect(markup).toContain('alt="Live Skills.sh install count"')
		expect(markup).toContain('flex h-7 items-center')
		expect(markup).not.toContain('Latest release')
	})
})
