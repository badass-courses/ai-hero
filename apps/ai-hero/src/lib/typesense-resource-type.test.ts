import { describe, expect, it } from 'vitest'

import { deriveResourceType } from './typesense-resource-type'

function resource(type: string, fields: Record<string, any> | null) {
	return { id: 'r1', type, fields } as any
}

describe('deriveResourceType', () => {
	it('indexes a resource under its own type by default', () => {
		expect(deriveResourceType(resource('post', { slug: 'a' }))).toBe('post')
		expect(deriveResourceType(resource('workshop', { slug: 'b' }))).toBe(
			'workshop',
		)
	})

	it('lets fields.postType override, so skill posts index as skills', () => {
		expect(
			deriveResourceType(resource('post', { postType: 'skill' })),
		).toBe('skill')
		expect(
			deriveResourceType(resource('post', { postType: 'skill-changelog' })),
		).toBe('skill-changelog')
	})

	// Regression: `fields.type` on a list is the list's flavour, not its
	// resource type. Trusting it typed `ai-engineering-crash-course~pniml` as a
	// workshop, and `getResourcePath('workshop', slug)` sends that to
	// `/workshops/<slug>` instead of `/<slug>`.
	it.each(['nextUp', 'tutorial', 'workshop'])(
		'keeps a list with fields.type %s indexed as a list',
		(flavour) => {
			expect(deriveResourceType(resource('list', { type: flavour }))).toBe(
				'list',
			)
		},
	)

	it('survives missing or empty fields', () => {
		expect(deriveResourceType(resource('post', null))).toBe('post')
		expect(deriveResourceType(resource('post', {}))).toBe('post')
		expect(deriveResourceType(resource('post', { postType: '' }))).toBe('post')
	})
})
