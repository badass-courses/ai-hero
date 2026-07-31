import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/github-stars-query', () => ({
	getRepoStarCount: vi.fn(),
}))

// The hero's course form is a client component that now calls a server action
// and a tRPC query, so rendering it drags next-auth into this file's import
// graph — and next-auth cannot resolve `next/server` under vitest, which fails
// the whole file at LOAD rather than on an assertion. Neither is what this test
// is about: it checks the hero's fact row.
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => null),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getSkillsCourseCtaState: {
				useQuery: () => ({ data: undefined, isPending: false }),
			},
		},
	},
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
