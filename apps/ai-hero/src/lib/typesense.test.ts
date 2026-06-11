import { describe, expect, it } from 'vitest'

import { TypesenseResourceSchema } from './typesense'

const baseValidResource = {
	id: 'post_123',
	title: 'A Post',
	slug: 'a-post',
	state: 'published',
	visibility: 'public',
	type: 'post',
}

describe('TypesenseResourceSchema', () => {
	it('accepts a document with popularity_30d', () => {
		const parsed = TypesenseResourceSchema.safeParse({
			...baseValidResource,
			popularity_30d: 1234,
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.popularity_30d).toBe(1234)
		}
	})

	it('accepts a document without popularity_30d (optional)', () => {
		const parsed = TypesenseResourceSchema.safeParse(baseValidResource)
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.popularity_30d).toBeUndefined()
		}
	})

	it('accepts popularity_30d of zero (boundary)', () => {
		const parsed = TypesenseResourceSchema.safeParse({
			...baseValidResource,
			popularity_30d: 0,
		})
		expect(parsed.success).toBe(true)
	})

	it('rejects negative popularity_30d', () => {
		const parsed = TypesenseResourceSchema.safeParse({
			...baseValidResource,
			popularity_30d: -5,
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects non-integer popularity_30d', () => {
		const parsed = TypesenseResourceSchema.safeParse({
			...baseValidResource,
			popularity_30d: 12.5,
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects non-number popularity_30d', () => {
		const parsed = TypesenseResourceSchema.safeParse({
			...baseValidResource,
			popularity_30d: 'lots',
		})
		expect(parsed.success).toBe(false)
	})
})

describe('TypesenseResourceSchema writer-doc shape guard', () => {
	// Regression guard: if any writer path drifts to include popularity_30d in
	// the doc it sends to Typesense, emplace will overwrite the daily sync's
	// value. The two writer paths in typesense-query.ts (upsertPostToTypeSense,
	// indexAllContentToTypeSense) construct their docs without popularity_30d.
	// This test asserts the parsed output for typical writer input also omits it.
	it('omits popularity_30d from parsed output when input does not include it', () => {
		const writerInput = {
			id: 'post_123',
			title: 'A Post',
			slug: 'a-post',
			description: 'body',
			summary: 'summary',
			image: 'https://example.com/i.jpg',
			type: 'post',
			visibility: 'public',
			state: 'published',
			created_at_timestamp: 1_700_000_000_000,
			updated_at_timestamp: 1_700_000_000_000,
		}
		const parsed = TypesenseResourceSchema.safeParse(writerInput)
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data).not.toHaveProperty('popularity_30d')
		}
	})
})
