import { describe, expect, it } from 'vitest'

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

	it('keys every entry by an ai-hero-images public id', () => {
		for (const id of redrawnIds) expect(id).toMatch(/^ai-hero-images\/[a-z0-9]+$/)
	})
})
