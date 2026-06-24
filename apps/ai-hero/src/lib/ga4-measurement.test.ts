import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractGA4ClientId, sendGA4Event } from './ga4-measurement'

describe('extractGA4ClientId', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('extracts the normalized GA client id from a raw _ga cookie', () => {
		expect(extractGA4ClientId('GA1.1.12345.67890')).toBe('12345.67890')
	})

	it('keeps an already-normalized GA client id', () => {
		expect(extractGA4ClientId('12345.67890')).toBe('12345.67890')
	})

	it('falls back to a generated id when no usable client id exists', () => {
		vi.spyOn(crypto, 'randomUUID').mockReturnValue(
			'00000000-0000-4000-8000-000000000000',
		)

		expect(extractGA4ClientId(undefined)).toBe(
			'00000000-0000-4000-8000-000000000000',
		)
		expect(extractGA4ClientId('not-a-ga-client-id')).toBe(
			'00000000-0000-4000-8000-000000000000',
		)
	})
})

describe('sendGA4Event', () => {
	const OLD_ENV = process.env

	afterEach(() => {
		process.env = OLD_ENV
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('returns a skipped receipt when Measurement Protocol config is missing', async () => {
		process.env = { ...OLD_ENV }
		delete process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS
		delete process.env.GA4_MEASUREMENT_API_SECRET

		const result = await sendGA4Event({
			client_id: '12345.67890',
			events: [{ name: 'purchase' }],
		})

		expect(result).toMatchObject({
			status: 'skipped_missing_config',
			eventNames: ['purchase'],
			eventCount: 1,
		})
	})

	it('returns a sent receipt when GA4 accepts the event', async () => {
		process.env = {
			...OLD_ENV,
			NEXT_PUBLIC_GOOGLE_ANALYTICS: 'G-TEST',
			GA4_MEASUREMENT_API_SECRET: 'test-secret',
		}
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
		vi.stubGlobal('fetch', fetchMock)

		const result = await sendGA4Event({
			client_id: '12345.67890',
			events: [{ name: 'purchase' }],
		})

		expect(result).toMatchObject({
			status: 'sent',
			httpStatus: 204,
			eventNames: ['purchase'],
			eventCount: 1,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('returns a failed receipt when GA4 rejects the event', async () => {
		process.env = {
			...OLD_ENV,
			NEXT_PUBLIC_GOOGLE_ANALYTICS: 'G-TEST',
			GA4_MEASUREMENT_API_SECRET: 'test-secret',
		}
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(null, { status: 400 })),
		)

		const result = await sendGA4Event({
			client_id: '12345.67890',
			events: [{ name: 'purchase' }],
		})

		expect(result).toMatchObject({
			status: 'failed',
			httpStatus: 400,
			reason: 'GA4 Measurement Protocol returned HTTP 400',
		})
	})
})
