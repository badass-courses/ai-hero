import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SkillSet, type SkillSetGroup } from './skill-set'

import { expect, test, vi } from 'vitest'

const group: SkillSetGroup = {
	id: 'section_1',
	title: 'Getting Started',
	items: [
		{
			slug: 'what-these-skills-are',
			title: 'What these skills are',
			description: 'The idea behind the set.',
			kind: 'article',
		},
		{
			slug: 'skills-ask-matt',
			title: 'The /ask-matt Skill',
			kind: 'skill',
		},
	],
}

const markup = () => renderToStaticMarkup(<SkillSet groups={[group]} />)

test('a skill row leads with its slash command', () => {
	expect(markup()).toContain('/ask-matt')
})

test('an article row is marked as one and shows no slash command', () => {
	const html = markup()

	expect(html).toContain('Article')
	// The bug this guards: an article rendering as `/what-these-skills-are`,
	// a command that does not exist.
	expect(html).not.toContain('/what-these-skills-are<')
	expect(html).toContain('href="/what-these-skills-are"')
})

test('"Start with" names the first SKILL, not an article above it', () => {
	const html = markup()

	expect(html).toContain('Start with')
	expect(html).toContain('>/ask-matt<')
})

test('a group holding only articles offers nothing to start with', () => {
	const html = renderToStaticMarkup(
		<SkillSet
			groups={[{ ...group, items: [group.items[0]!] }]}
		/>,
	)

	expect(html).not.toContain('Start with')
})

test('a skill without an icon renders no image slot at all', () => {
	// Explicit product call (2026-08-24): hide the slot rather than fill it
	// with a placeholder — iconless rows keep their pre-icon shape.
	const html = markup()

	expect(html).not.toContain('<img')
	expect(html).not.toContain('bg-stripes')
})

test('a skill with an icon renders it as a decorative image', () => {
	// next-cloudinary resolves its cloud name at render time.
	vi.stubEnv('NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME', 'test-cloud')
	const html = renderToStaticMarkup(
		<SkillSet
			groups={[
				{
					...group,
					items: [
						{
							slug: 'skills-ask-matt',
							title: 'The /ask-matt Skill',
							kind: 'skill',
							iconUrl: 'https://res.cloudinary.com/x/icon.png',
						},
					],
				},
			]}
		/>,
	)

	expect(html).toContain('<img')
	expect(html).toContain('alt=""')
	expect(html).not.toContain('bg-stripes')
})
