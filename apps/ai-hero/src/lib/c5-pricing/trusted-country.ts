import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The buyer's country for pricing comes only from AI Hero's trusted request
 * geolocation: Vercel's `x-vercel-ip-country`, then `DEFAULT_COUNTRY`, then
 * US, the same source `coursebuilder-request-authorization.ts` uses. A query
 * or body `country` never reaches the C5 hook.
 *
 * The coursebuilder route runs Course Builder inside `withTrustedPricingCountry`;
 * the signed-in checkout page runs it with the country its signed handoff
 * carries. Anywhere else in a request, the request's own headers answer.
 */
const scope = new AsyncLocalStorage<{ readonly country: string }>()

export function normalizeCountry(raw: string | null | undefined) {
	const value = raw?.trim().toUpperCase()
	return value && /^[A-Z]{2}$/.test(value) ? value : null
}

export function trustedCountryFromHeaders(headers: Pick<Headers, 'get'>) {
	return (
		normalizeCountry(headers.get('x-vercel-ip-country')) ??
		normalizeCountry(process.env.DEFAULT_COUNTRY) ??
		'US'
	)
}

export function withTrustedPricingCountry<T>(country: string, run: () => T): T {
	return scope.run({ country: normalizeCountry(country) ?? 'US' }, run)
}

/** Null outside any request, where no country is trusted. */
export async function trustedPricingCountry(): Promise<string | null> {
	const scoped = scope.getStore()
	if (scoped) return scoped.country
	try {
		const { headers } = await import('next/headers')
		return trustedCountryFromHeaders(await headers())
	} catch {
		return null
	}
}
