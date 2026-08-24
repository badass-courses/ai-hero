import { countSkills, toSkillGroups } from './skill-groups'

import { describe, expect, test } from 'vitest'

const published = { state: 'published', visibility: 'public' }

const skill = (slug: string, title = `The /${slug} Skill`) => ({
	resource: {
		id: `post_${slug}`,
		type: 'post',
		fields: { ...published, postType: 'skill', slug, title },
	},
})

const article = (slug: string, title: string) => ({
	resource: {
		id: `post_${slug}`,
		type: 'post',
		fields: { ...published, postType: 'article', slug, title },
	},
})

const section = (id: string, title: string, children: unknown[]) => ({
	resource: {
		id,
		type: 'section',
		fields: { title },
		resources: children as any,
	},
})

describe('toSkillGroups', () => {
	test('marks a non-skill post as an article, and a skill post as a skill', () => {
		const [group] = toSkillGroups([
			section('section_1', 'Getting Started', [
				article('what-these-skills-are', 'What these skills are'),
				skill('skills-ask-matt'),
			]),
		])

		expect(group?.items.map((item) => item.kind)).toEqual(['article', 'skill'])
	})

	test('carries a skill icon url through, and drops empty/cleared icons', () => {
		const withIcon = skill('skills-ask-matt')
		;(withIcon.resource.fields as any).icon = {
			url: 'https://res.cloudinary.com/x/icon.png',
			alt: 'mark',
		}
		const emptyIcon = skill('skills-grill-me')
		;(emptyIcon.resource.fields as any).icon = { url: '' }
		const clearedIcon = skill('skills-plan-this')
		;(clearedIcon.resource.fields as any).icon = null
		// Raw JSON can hold what PostSchema would reject (e.g. written via the
		// passthrough /api/resources) — next/image throws on a src it cannot
		// parse, so a junk url must not reach the catalog.
		const junkIcon = skill('skills-review-this')
		;(junkIcon.resource.fields as any).icon = { url: 'not-a-url' }

		const [group] = toSkillGroups([
			section('section_1', 'Getting Started', [
				withIcon,
				emptyIcon,
				clearedIcon,
				junkIcon,
				skill('skills-ship-it'),
			]),
		])

		expect(group?.items.map((item) => item.iconUrl)).toEqual([
			'https://res.cloudinary.com/x/icon.png',
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})

	test('a missing postType is an article, never a skill', () => {
		// The catalog used to gate on publish state alone, so anything in the
		// list rendered a slash command. Absent metadata must fail toward the
		// row you cannot invoke.
		const [group] = toSkillGroups([
			{
				resource: {
					id: 'post_x',
					type: 'post',
					fields: { ...published, slug: 'mystery', title: 'Mystery' },
				},
			},
		])

		expect(group?.items[0]?.kind).toBe('article')
	})

	test('keeps list order — an article does not sort to the end', () => {
		const [group] = toSkillGroups([
			section('section_1', 'Getting Started', [
				article('what-these-skills-are', 'What these skills are'),
				skill('skills-ask-matt'),
			]),
		])

		expect(group?.items.map((item) => item.slug)).toEqual([
			'what-these-skills-are',
			'skills-ask-matt',
		])
	})

	test('drops unpublished and unlisted members', () => {
		const groups = toSkillGroups([
			section('section_1', 'Getting Started', [
				{
					resource: {
						id: 'post_draft',
						type: 'post',
						fields: {
							state: 'draft',
							visibility: 'public',
							postType: 'article',
							slug: 'draft',
							title: 'Draft',
						},
					},
				},
			]),
		])

		expect(groups).toEqual([])
	})
})

describe('countSkills', () => {
	test('counts skills only, so an article cannot inflate "N skills"', () => {
		const groups = toSkillGroups([
			section('section_1', 'Getting Started', [
				article('what-these-skills-are', 'What these skills are'),
				skill('skills-ask-matt'),
				skill('skills-setup'),
			]),
		])

		expect(groups[0]?.items).toHaveLength(3)
		expect(countSkills(groups)).toBe(2)
	})

	test('counts loose members too', () => {
		const groups = toSkillGroups([
			skill('skills-loose'),
			article('loose-article', 'Loose article'),
		])

		expect(countSkills(groups)).toBe(1)
	})
})
