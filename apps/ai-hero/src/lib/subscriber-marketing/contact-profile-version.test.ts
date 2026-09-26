import { describe, expect, it } from 'vitest'

import { createMemoryContactProfileVersionStore } from './contact-profile-version'

describe('contact profile version', () => {
	it('counts up from 1 per contact', async () => {
		const store = createMemoryContactProfileVersionStore()
		await expect(store.bump('contact-1')).resolves.toBe(1)
		await expect(store.bump('contact-1')).resolves.toBe(2)
		await expect(store.bump('contact-2')).resolves.toBe(1)
		await expect(store.bump('contact-1')).resolves.toBe(3)
	})

	it('never hands two concurrent bumps the same version', async () => {
		const store = createMemoryContactProfileVersionStore()
		const versions = await Promise.all(
			Array.from({ length: 8 }, () => store.bump('contact-1')),
		)
		expect([...versions].sort((a, b) => a - b)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8,
		])
	})
})
