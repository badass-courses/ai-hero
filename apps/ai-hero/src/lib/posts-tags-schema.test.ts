import { describe, expect, it } from 'vitest'

import { PostTagsSchema } from './posts'

// zod 4 rejects a missing key for a bare z.any() field; the ContentResourceTag
// join table has no deletedAt column, so every tagged post failed to parse and
// rendered 404 in production on 2026-09-18.
describe('PostTagsSchema', () => {
	it('accepts a tag join row without a deletedAt key', () => {
		const result = PostTagsSchema.safeParse([
			{
				contentResourceId: 'post_1',
				organizationId: null,
				tagId: 'tag_1',
				position: 0,
				createdAt: '2026-09-18T00:00:00.000Z',
				updatedAt: '2026-09-18T00:00:00.000Z',
				tag: {
					id: 'tag_1',
					type: 'topic',
					fields: { name: 'AI', label: 'AI', slug: 'ai' },
					createdAt: new Date(),
					updatedAt: new Date(),
					deletedAt: null,
				},
			},
		])
		expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
	})
})
