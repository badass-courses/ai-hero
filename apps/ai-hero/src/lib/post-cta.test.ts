import { describe, expect, it } from 'vitest'

import { resolvePostCta } from './post-cta'

describe('resolvePostCta', () => {
	it('defaults skill posts to the course CTA', () => {
		expect(
			resolvePostCta({
				postType: 'skill',
				cta: undefined,
			}),
		).toMatchObject({
			kind: 'course',
			source: 'postType',
			warning: null,
		})
	})

	it('lets an explicit none field suppress the skill default', () => {
		expect(
			resolvePostCta({
				postType: 'skill',
				cta: 'none',
			}),
		).toEqual({
			kind: null,
			copy: null,
			source: 'field',
			warning: null,
		})
	})

	it('falls back safely and reports an unrecognised field', () => {
		expect(
			resolvePostCta({
				postType: 'skill',
				cta: 'surprise',
			}),
		).toMatchObject({
			kind: 'course',
			source: 'postType',
			warning: {
				code: 'unrecognised-post-cta',
			},
		})
	})

	it('lets a course field override an article default', () => {
		expect(
			resolvePostCta({
				postType: 'article',
				cta: 'course',
			}),
		).toMatchObject({
			kind: 'course',
			source: 'field',
			warning: null,
		})
	})

	it('uses field copy and falls back for each absent copy value', () => {
		const defaults = resolvePostCta({
			postType: 'skill',
			cta: undefined,
		})
		const resolved = resolvePostCta({
			postType: 'skill',
			cta: {
				kind: 'course',
				headline: 'Page-specific headline',
			},
		})

		expect(resolved).toMatchObject({
			kind: 'course',
			copy: {
				headline: 'Page-specific headline',
			},
			source: 'field',
		})
		expect(resolved.copy?.subtitle).toBe(defaults.copy?.subtitle)
	})
})
