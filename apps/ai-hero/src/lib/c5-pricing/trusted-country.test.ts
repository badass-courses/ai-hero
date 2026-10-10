import { afterEach, describe, expect, it, vi } from 'vitest'

const headerMock = vi.hoisted(() => ({
	headers: vi.fn(async () => new Headers({ 'x-vercel-ip-country': 'CA' })),
}))
vi.mock('next/headers', () => headerMock)

import {
	normalizeCountry,
	trustedCountryFromHeaders,
	trustedPricingCountry,
	withTrustedPricingCountry,
} from './trusted-country'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('trusted pricing country', () => {
	it('reads only the platform geolocation header', () => {
		expect(
			trustedCountryFromHeaders(
				new Headers({ 'x-vercel-ip-country': 'in', country: 'BR' }),
			),
		).toBe('IN')
	})

	it('falls back to DEFAULT_COUNTRY, then US, never to anything the client sent', () => {
		vi.stubEnv('DEFAULT_COUNTRY', 'GB')
		expect(trustedCountryFromHeaders(new Headers({ country: 'IN' }))).toBe('GB')
		vi.stubEnv('DEFAULT_COUNTRY', '')
		expect(trustedCountryFromHeaders(new Headers())).toBe('US')
	})

	it('rejects malformed country codes', () => {
		expect(normalizeCountry('USA')).toBeNull()
		expect(normalizeCountry('i n')).toBeNull()
		expect(normalizeCountry(undefined)).toBeNull()
	})

	it('prefers the scoped country, then the request headers', async () => {
		await expect(trustedPricingCountry()).resolves.toBe('CA')
		await expect(
			withTrustedPricingCountry('tr', () => trustedPricingCountry()),
		).resolves.toBe('TR')
	})

	it('is null outside a request', async () => {
		headerMock.headers.mockRejectedValueOnce(new Error('outside a request'))
		await expect(trustedPricingCountry()).resolves.toBeNull()
	})
})
