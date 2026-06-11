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

	it('rejects a coverImage with a non-url string', () => {
		expect(() =>
			PostSchema.parse({
				...baseResource,
				fields: { ...baseFields, coverImage: { url: 'not-a-url' } },
			}),
		).toThrow()
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
