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
		useUtils: () => ({
			ability: { getSkillsCourseCtaState: { invalidate: vi.fn() } },
		}),
	},
}))

// SkillsHero renders SkillsCourseForm, a client component that calls
// useRouter() from next/navigation. renderToStaticMarkup has no app router
// context, so the real hook throws "invariant expected app router to be
// mounted" — mock it the same way the other skills CTA tests do.
vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: vi.fn() }),
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
		// The `flex h-7 items-center` wrapper this used to check for is gone —
		// the stats row layout changed to `dl` with `flex flex-wrap items-end
		// gap-x-[30px] gap-y-5` (see Stats() in skills-hero.tsx). The assertions
		// above already cover what this test is about: the badge and its data.
		expect(markup).not.toContain('Latest release')
		expect(markup).toContain(
			'This is a seven-lesson email course. Lesson 1 arrives as soon as you sign up. The lesson is the email itself. It will not appear under Courses in your AI Hero account.',
		)
		expect(markup).toContain(
			'Answer the question at the end if you want the next lesson in a few minutes. Otherwise, the next lesson arrives automatically after at least 18 hours.',
		)
	})
})
