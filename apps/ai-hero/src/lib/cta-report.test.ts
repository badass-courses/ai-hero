import { describe, expect, it } from 'vitest'

import { buildPostAskInventories, scanBodyAuthoredCtas } from './cta-report'
import { resolvePostCta } from './post-cta'

describe('shared resolvePostCta', () => {
	it('defaults skill posts to the course CTA', () => {
		expect(resolvePostCta({ postType: 'skill', cta: undefined })).toMatchObject({
			kind: 'course',
			source: 'postType',
			warning: null,
		})
	})

	it('lets fields.cta opt a skill post out', () => {
		expect(
			resolvePostCta({ postType: 'skill', cta: 'none' }),
		).toMatchObject({
			kind: null,
			source: 'field',
			warning: null,
		})
	})

	it('keeps optional field copy', () => {
		expect(
			resolvePostCta({
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
			source: 'field',
		})
	})

	it('reports an unknown field and falls back to the post type', () => {
		expect(
			resolvePostCta({ postType: 'skill', cta: 'surprise' }),
		).toMatchObject({
			kind: 'course',
			source: 'postType',
			warning: { code: 'unrecognised-post-cta' },
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

describe('buildPostAskInventories', () => {
	it('swaps PrimaryNewsletterCta for the course on a non-video skill post', () => {
		const inventories = buildPostAskInventories({
			bodyAuthoredCtas: [],
			hasVideo: false,
			organicCtaKind: undefined,
			resolvedCta: resolvePostCta({
				postType: 'skill',
				cta: undefined,
			}),
		})

		expect(inventories.merged.currentTemplateCtas).toMatchObject([
			{
				component: 'SkillsCourseCta',
				capturesEmailOnPage: true,
				rendersForCurrentRoute: true,
			},
		])
		expect(inventories.merged.totalAnonymousReaderEmailAsks).toBe(1)
		expect(
			inventories.merged.currentTemplateCtas.some(
				(cta) => cta.component === 'PrimaryNewsletterCta',
			),
		).toBe(false)
		expect(
			inventories.productionBeforeMerge.currentTemplateCtas[0]?.component,
		).toBe('PrimaryNewsletterCta')
	})

	it('takes a video skill post from zero asks to one course ask', () => {
		const inventories = buildPostAskInventories({
			bodyAuthoredCtas: [],
			hasVideo: true,
			organicCtaKind: undefined,
			resolvedCta: resolvePostCta({
				postType: 'skill',
				cta: undefined,
			}),
		})

		expect(
			inventories.productionBeforeMerge.totalAnonymousReaderEmailAsks,
		).toBe(0)
		expect(inventories.merged.totalAnonymousReaderEmailAsks).toBe(1)
		expect(inventories.merged.anonymousReaderEmailAsks[0]?.component).toBe(
			'SkillsCourseCta',
		)
	})

	it('renders the non-capturing organic CTA after the course CTA', () => {
		const inventories = buildPostAskInventories({
			bodyAuthoredCtas: [],
			hasVideo: true,
			organicCtaKind: 'skills',
			resolvedCta: resolvePostCta({
				postType: 'skill',
				cta: undefined,
			}),
		})

		expect(
			inventories.merged.currentTemplateCtas.map((cta) => ({
				component: cta.component,
				capturesEmailOnPage: cta.capturesEmailOnPage,
			})),
		).toEqual([
			{ component: 'SkillsCourseCta', capturesEmailOnPage: true },
			{ component: 'OrganicOpportunityCta', capturesEmailOnPage: false },
		])
		expect(inventories.merged.totalAnonymousReaderEmailAsks).toBe(1)
	})

	it('keeps the generic ask when no course resolves', () => {
		const inventories = buildPostAskInventories({
			bodyAuthoredCtas: [],
			hasVideo: false,
			organicCtaKind: 'ai-engineer',
			resolvedCta: resolvePostCta({
				postType: 'article',
				cta: undefined,
			}),
		})

		expect(
			inventories.merged.currentTemplateCtas.map((cta) => cta.component),
		).toEqual(['OrganicOpportunityCta', 'PrimaryNewsletterCta'])
		expect(inventories.merged.totalAnonymousReaderEmailAsks).toBe(1)
	})
})
