import { PostSchema, PostUpdateSchema } from '@/lib/posts'
import { describe, expect, it } from 'vitest'

const baseFields = {
	postType: 'article' as const,
	title: 'Test Post',
	slug: 'test-post',
	state: 'draft' as const,
	visibility: 'public' as const,
}

const baseResource = {
	id: 'post_123',
	type: 'post',
	createdById: 'user_1',
	organizationId: 'org_1',
	createdByOrganizationMembershipId: 'mem_1',
	createdAt: new Date(),
	updatedAt: new Date(),
	deletedAt: null,
	tags: [],
}

describe('PostSchema artwork fields', () => {
	it('parses a post with coverImage and _artwork', () => {
		const result = PostSchema.parse({
			...baseResource,
			fields: {
				...baseFields,
				coverImage: { url: 'https://res.cloudinary.com/x/y.png', alt: 'cover' },
				_artwork: {
					batchId: 'batch_abc',
					startedAt: '2026-05-04T12:00:00.000Z',
				},
			},
		})

		expect(result.fields.coverImage?.url).toBe(
			'https://res.cloudinary.com/x/y.png',
		)
		expect(result.fields._artwork?.batchId).toBe('batch_abc')
	})

	it('parses a post with neither artwork field set', () => {
		const result = PostSchema.parse({
			...baseResource,
			fields: baseFields,
		})

		expect(result.fields.coverImage).toBeUndefined()
		expect(result.fields._artwork).toBeUndefined()
	})

	it('keeps coverImage.source through a parse — the strip-schema write-back must not erase it', () => {
		const result = PostSchema.parse({
			...baseResource,
			fields: {
				...baseFields,
				coverImage: {
					url: 'https://res.cloudinary.com/x/y.png',
					source: 'uploaded',
				},
			},
		})

		expect(result.fields.coverImage?.source).toBe('uploaded')
	})

	it('rejects an unknown coverImage.source label', () => {
		expect(() =>
			PostSchema.parse({
				...baseResource,
				fields: {
					...baseFields,
					coverImage: {
						url: 'https://res.cloudinary.com/x/y.png',
						source: 'designed',
					},
				},
			}),
		).toThrow()
	})

	it('rejects a coverImage with a non-url string', () => {
		expect(() =>
			PostSchema.parse({
				...baseResource,
				fields: { ...baseFields, coverImage: { url: 'not-a-url' } },
			}),
		).toThrow()
	})
})

describe('PostSchema icon field', () => {
	it('parses a skill post with an icon', () => {
		const result = PostSchema.parse({
			...baseResource,
			fields: {
				...baseFields,
				postType: 'skill',
				icon: { url: 'https://res.cloudinary.com/x/icon.png', alt: 'mark' },
			},
		})

		expect(result.fields.icon?.url).toBe(
			'https://res.cloudinary.com/x/icon.png',
		)
	})

	it('accepts the editor empty ("") and cleared (null) states', () => {
		expect(
			PostSchema.parse({
				...baseResource,
				fields: { ...baseFields, icon: { url: '' } },
			}).fields.icon?.url,
		).toBe('')
		expect(
			PostSchema.parse({
				...baseResource,
				fields: { ...baseFields, icon: null },
			}).fields.icon,
		).toBeNull()
	})

	it('rejects an icon with a non-url string', () => {
		expect(() =>
			PostSchema.parse({
				...baseResource,
				fields: { ...baseFields, icon: { url: 'not-a-url' } },
			}),
		).toThrow()
	})

	it('accepts icon on update (so saves cannot erase it)', () => {
		const result = PostUpdateSchema.parse({
			id: 'post_123',
			fields: {
				postType: 'skill',
				title: 'Test Post',
				slug: 'test-post',
				icon: { url: 'https://res.cloudinary.com/x/icon.png' },
			},
			tags: [],
		})

		expect(result.fields.icon?.url).toBe(
			'https://res.cloudinary.com/x/icon.png',
		)
	})
})

describe('PostSchema CTA field', () => {
	it('preserves a typed course CTA with optional copy', () => {
		const result = PostSchema.parse({
			...baseResource,
			fields: {
				...baseFields,
				cta: {
					kind: 'course',
					headline: 'Page-specific headline',
					subtitle: 'Page-specific subtitle',
				},
			},
		})

		expect(result.fields.cta).toEqual({
			kind: 'course',
			headline: 'Page-specific headline',
			subtitle: 'Page-specific subtitle',
		})
	})

	it('normalises an unrecognised CTA without rejecting the post', () => {
		const result = PostSchema.parse({
			...baseResource,
			fields: {
				...baseFields,
				cta: 'surprise',
			},
		})

		expect(result.fields.cta).toEqual({ kind: 'unrecognised' })
	})
})

describe('PostUpdateSchema artwork fields', () => {
	it('accepts coverImage on update', () => {
		const result = PostUpdateSchema.parse({
			id: 'post_123',
			fields: {
				postType: 'article',
				title: 'Test Post',
				slug: 'test-post',
				coverImage: {
					url: 'https://res.cloudinary.com/x/y.png',
					alt: 'cover',
				},
			},
			tags: [],
		})

		expect(result.fields.coverImage?.url).toBe(
			'https://res.cloudinary.com/x/y.png',
		)
	})

	it('strips _artwork from update payloads (not in update schema)', () => {
		const result = PostUpdateSchema.parse({
			id: 'post_123',
			fields: {
				postType: 'article',
				title: 'Test Post',
				slug: 'test-post',
				_artwork: { batchId: 'batch_abc' },
			} as any,
			tags: [],
		})

		expect((result.fields as any)._artwork).toBeUndefined()
	})
})

describe('PostUpdateSchema cross-promo fields', () => {
	it('preserves course suppression and related-post strategy on update', () => {
		const result = PostUpdateSchema.parse({
			id: 'post_123',
			fields: {
				postType: 'article',
				title: 'Test Post',
				slug: 'test-post',
				suppressCourseCta: true,
				relatedPostsVariant: 'suggested',
			},
			tags: [],
		})

		expect(result.fields.suppressCourseCta).toBe(true)
		expect(result.fields.relatedPostsVariant).toBe('suggested')
	})
})
