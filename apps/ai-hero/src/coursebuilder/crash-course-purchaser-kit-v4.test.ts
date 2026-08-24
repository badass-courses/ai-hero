import { describe, expect, it, vi } from 'vitest'

import { createCrashCoursePurchaserTagger } from './crash-course-purchaser-kit-v4'

describe('Crash Course purchaser Kit v4 adapter', () => {
	it('attaches the fixed tag to the existing subscriber', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ subscriber: { id: 41 } }), {
				status: 200,
			}),
		)
		const tagSubscriber = createCrashCoursePurchaserTagger({
			apiKey: 'kit-v4-key',
			fetcher,
		})

		await expect(tagSubscriber('41')).resolves.toEqual({ subscriberId: '41' })
		expect(fetcher).toHaveBeenCalledWith(
			'https://api.kit.com/v4/tags/22490749/subscribers/41',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Kit-Api-Key': 'kit-v4-key',
				},
				body: '{}',
			},
		)
	})

	it('throws on a non-success response', async () => {
		const tagSubscriber = createCrashCoursePurchaserTagger({
			apiKey: 'kit-v4-key',
			fetcher: vi.fn().mockResolvedValue(new Response('', { status: 429 })),
		})

		await expect(tagSubscriber('41')).rejects.toThrow(
			'Kit purchaser tag write failed with HTTP 429',
		)
	})

	it('throws when the response does not confirm the same subscriber', async () => {
		const tagSubscriber = createCrashCoursePurchaserTagger({
			apiKey: 'kit-v4-key',
			fetcher: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ subscriber: { id: 99 } }), {
					status: 200,
				}),
			),
		})

		await expect(tagSubscriber('41')).rejects.toThrow(
			'Kit purchaser tag response subscriber did not match',
		)
	})

	it('throws on a malformed success response', async () => {
		const tagSubscriber = createCrashCoursePurchaserTagger({
			apiKey: 'kit-v4-key',
			fetcher: vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ subscriber: {} }), { status: 200 }),
				),
		})

		await expect(tagSubscriber('41')).rejects.toThrow(
			'Kit purchaser tag response subscriber did not match',
		)
	})

	it('throws when a success response is not JSON', async () => {
		const tagSubscriber = createCrashCoursePurchaserTagger({
			apiKey: 'kit-v4-key',
			fetcher: vi
				.fn()
				.mockResolvedValue(new Response('not-json', { status: 200 })),
		})

		await expect(tagSubscriber('41')).rejects.toThrow(
			'Kit purchaser tag response was not valid JSON',
		)
	})
})
