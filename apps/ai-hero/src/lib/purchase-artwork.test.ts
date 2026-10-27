import { describe, expect, it } from 'vitest'
import { purchaseArtwork } from './purchase-artwork'

describe('purchase artwork', () => {
	it("prefers the product's own image", () => {
		expect(
			purchaseArtwork({
				fields: { image: { url: 'https://example.test/product.png' } },
				resources: [{ resource: { fields: { image: 'https://example.test/cohort.png' } } }],
			}),
		).toBe('https://example.test/product.png')
	})

	it("falls back to the cohort's image, then the workshop's cover", () => {
		expect(
			purchaseArtwork({
				fields: {},
				resources: [{ resource: { fields: { image: 'https://example.test/cohort.png' } } }],
			}),
		).toBe('https://example.test/cohort.png')
		expect(
			purchaseArtwork({
				fields: { image: null },
				resources: [
					{ resource: { fields: { coverImage: { url: 'https://example.test/cover.jpg' } } } },
				],
			}),
		).toBe('https://example.test/cover.jpg')
	})

	it('is null when there is no picture anywhere', () => {
		expect(purchaseArtwork(null)).toBeNull()
		expect(purchaseArtwork({ fields: {}, resources: [] })).toBeNull()
	})
})
