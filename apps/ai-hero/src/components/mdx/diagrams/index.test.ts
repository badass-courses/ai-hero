import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { serializeToMarkdown } from '@/lib/markdown-serializer'

import { publicIdOf, redrawForImage, redrawnIds } from '.'

describe('publicIdOf', () => {
	it('reads the id from a markdown link', () => {
		expect(
			publicIdOf(
				'https://res.cloudinary.com/total-typescript/image/upload/v1793202934/ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54.png',
			),
		).toBe('ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54')
	})

	it('sees through transformations and a query string', () => {
		expect(
			publicIdOf(
				'https://res.cloudinary.com/total-typescript/image/upload/c_limit,w_1920/f_auto/q_auto/v1793202934/ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54?_a=BAVMn6E80',
			),
		).toBe('ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54')
	})

	it('has nothing for a non-Cloudinary source', () => {
		expect(publicIdOf('/yes.png')).toBeNull()
		expect(publicIdOf(undefined)).toBeNull()
	})
})

describe('redrawForImage', () => {
	it('redraws a registered image', () => {
		expect(
			redrawForImage(
				'https://res.cloudinary.com/total-typescript/image/upload/v1793202934/ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54.png',
			),
		).not.toBeNull()
	})

	it('leaves every other image alone', () => {
		expect(
			redrawForImage(
				'https://res.cloudinary.com/total-typescript/image/upload/v1/ai-hero-images/not-a-redrawn-image',
			),
		).toBeNull()
	})

	it('ignores ids inherited from Object', () => {
		expect(
			redrawForImage(
				'https://res.cloudinary.com/total-typescript/image/upload/v1/constructor',
			),
		).toBeNull()
	})

	it('keeps the image alt for screen readers', () => {
		const html = renderToStaticMarkup(
			redrawForImage(
				'https://res.cloudinary.com/total-typescript/image/upload/v1793202934/ai-hero-images/ed01d9d48a02cd95c0a07cd677ff5b54.png',
				'The implement loop',
			),
		)
		expect(html).toContain('<span class="sr-only">The implement loop</span>')
	})

	it('keys every entry by an ai-hero-images public id', () => {
		for (const id of redrawnIds)
			expect(id).toMatch(/^ai-hero-images\/[a-z0-9]+$/)
	})
})

describe('markdown readers', () => {
	it('get the original image, alt text and all, for a redrawn one', () => {
		const image =
			'![The explore tickets task diagrammed across lanes](https://res.cloudinary.com/total-typescript/image/upload/v1793187405/ai-hero-images/0a79b278f76b033da33c7b0f37d79400.png)'
		// The swap happens when the body renders as MDX; markdown is the body
		// as stored, so it must still be Matt's image.
		expect(
			redrawForImage(
				'https://res.cloudinary.com/total-typescript/image/upload/v1793187405/ai-hero-images/0a79b278f76b033da33c7b0f37d79400.png',
			),
		).not.toBeNull()
		const markdown = serializeToMarkdown({
			id: 'lesson',
			type: 'lesson',
			fields: {
				title: 'Whiteboard Your Own Tasks',
				slug: 'whiteboard-your-own-tasks',
				body: `I've diagrammed the explore tickets task first.\n\n${image}\n`,
			},
		})
		expect(markdown).toContain(image)
		expect(markdown).not.toMatch(/<figure|<svg|data-flow/)
	})
})
