import { describe, expect, it } from 'vitest'

import { resolveCtaDeclaration, scanBodyAuthoredCtas } from './cta-report'

describe('resolveCtaDeclaration', () => {
	it('defaults skill posts to the course CTA', () => {
		expect(resolveCtaDeclaration({ postType: 'skill' })).toMatchObject({
			kind: 'course',
			source: 'postType',
			recognized: true,
		})
	})

	it('lets fields.cta opt a skill post out', () => {
		expect(
			resolveCtaDeclaration({ postType: 'skill', cta: 'none' }),
		).toMatchObject({
			kind: 'none',
			source: 'fields.cta',
			recognized: true,
		})
	})

	it('keeps optional field copy', () => {
		expect(
			resolveCtaDeclaration({
				postType: 'article',
				cta: {
					kind: 'course',
					headline: 'Free course',
					subtitle: 'Seven days',
				},
			}),
		).toMatchObject({
			kind: 'course',
			copy: { headline: 'Free course', subtitle: 'Seven days' },
			source: 'fields.cta',
		})
	})

	it('reports an unknown field and falls back to the post type', () => {
		expect(
			resolveCtaDeclaration({ postType: 'skill', cta: 'surprise' }),
		).toMatchObject({
			kind: 'course',
			source: 'postType',
			recognized: false,
			rawKind: 'surprise',
		})
	})
})

describe('scanBodyAuthoredCtas', () => {
	it('returns component names and source lines without body copy', () => {
		const body = [
			'# Post',
			'',
			'<SkillsNewsletterCta heading="Keep learning" />',
			'<SkillsCta />',
			'<PromoCard',
			'  href="/cohort"',
			'/>',
		].join('\n')

		expect(scanBodyAuthoredCtas(body)).toEqual([
			{
				component: 'SkillsNewsletterCta',
				line: 3,
				capturesEmailForAnonymousReader: true,
				subscriberConditional: true,
			},
			{
				component: 'SkillsCta',
				line: 4,
				capturesEmailForAnonymousReader: false,
				subscriberConditional: false,
			},
			{
				component: 'PromoCard',
				line: 5,
				capturesEmailForAnonymousReader: false,
				subscriberConditional: false,
			},
		])
	})

	it('ignores examples in code fences and MDX comments', () => {
		const body = [
			'```mdx',
			'<SkillsNewsletterCta />',
			'```',
			'{/* <SkillsCourseCta /> */}',
			'<SkillsCourseCta />',
		].join('\n')

		expect(scanBodyAuthoredCtas(body)).toHaveLength(1)
		expect(scanBodyAuthoredCtas(body)[0]).toMatchObject({
			component: 'SkillsCourseCta',
			line: 5,
		})
	})
})
