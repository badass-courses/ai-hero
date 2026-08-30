import 'server-only'

import cityCentroids from '@/app/admin/globe/_data/city-centroids.json'
import countryCentroids from '@/app/admin/globe/_data/country-centroids.json'
import regionCentroids from '@/app/admin/globe/_data/region-centroids.json'
import usZipCentroids from '@/app/admin/globe/_data/us-zip-centroids.json'
import { z } from 'zod'

export type GlobePrecision = 'ip' | 'postal' | 'city' | 'region' | 'country'

export type GlobeLocation = Readonly<{
	lat: number
	lng: number
	city: string | null
	region: string | null
	precision: GlobePrecision
}>

export type GlobeSource = 'vercel' | 'stripe-billing'

export type CheckoutGeoMetadata = Readonly<{
	city?: string | null
	region?: string | null
	latitude?: string | null
	longitude?: string | null
	ip_address?: string | null
}>

export type StripeBillingAddress = Readonly<{
	city: string | null
	region: string | null
	postal: string | null
	country: string | null
}>

export type GlobeGeoDatasets = Readonly<{
	postal: Readonly<Record<string, readonly number[]>>
	cities: Readonly<Record<string, readonly number[]>>
	regions: Readonly<Record<string, readonly number[]>>
	countries: Readonly<Record<string, readonly number[]>>
}>

const CachedGlobeLocationSchema = z.object({
	lat: z.number().finite(),
	lng: z.number().finite(),
	city: z.string().min(1).nullable().optional(),
	region: z.string().min(1).nullable().optional(),
	precision: z.enum(['ip', 'postal', 'city', 'region', 'country']),
})

const defaultDatasets: GlobeGeoDatasets = {
	postal: usZipCentroids,
	cities: cityCentroids,
	regions: regionCentroids,
	countries: countryCentroids,
}

/**
 * Collapse a place name so Kraków, krakow, and KRK-adjacent Stripe values match.
 */
export function normalizePlace(
	value: string | null | undefined
): string | null {
	const normalized = value
		?.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ')
	return normalized || null
}

export function normalizeCountryCode(
	country: string | null | undefined
): string | null {
	const normalized = country?.trim().toUpperCase()
	return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : null
}

/**
 * US ZIP5 from Stripe postal, otherwise a trimmed postal string.
 */
export function normalizePostal(
	country: string | null | undefined,
	postal: string | null | undefined
): string | null {
	const trimmed = postal?.trim()
	if (!trimmed) return null
	if (normalizeCountryCode(country) === 'US') {
		const zip = trimmed.match(/\d{5}/)?.[0]
		return zip ?? null
	}
	return trimmed.slice(0, 16)
}

function pair(
	value: readonly number[] | undefined
): { lat: number; lng: number } | null {
	const lat = value?.[0]
	const lng = value?.[1]
	return typeof lat === 'number' &&
		typeof lng === 'number' &&
		Number.isFinite(lat) &&
		Number.isFinite(lng)
		? { lat, lng }
		: null
}

function parseCoordinate(value: string | number | null | undefined): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null
	}
	if (!value) return null
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

function parseCoordinatePair(
	latitude: string | number | null | undefined,
	longitude: string | number | null | undefined
): { lat: number; lng: number } | null {
	const lat = parseCoordinate(latitude)
	const lng = parseCoordinate(longitude)
	return lat !== null && lng !== null ? { lat, lng } : null
}

/**
 * First hop from Stripe/Vercel metadata, dropping the dummy checkout fallback.
 */
export function normalizeIpAddress(
	value: string | null | undefined
): string | null {
	const first = value?.split(',')[0]?.trim()
	if (!first || first === '0.0.0.0' || first === '::') return null
	return first.slice(0, 191)
}

function optionalTrimmed(value: string | null | undefined): string | null {
	const normalized = value?.trim()
	return normalized ? normalized : null
}

/**
 * Resolve a globe ping. Finer sources win. Never invent a coordinate.
 */
export function resolveGlobeLocation(
	input: {
		country: string | null
		city?: string | null
		region?: string | null
		postal?: string | null
		latitude?: string | number | null
		longitude?: string | number | null
	},
	datasets: GlobeGeoDatasets = defaultDatasets
): GlobeLocation | null {
	const country = normalizeCountryCode(input.country)
	const city = optionalTrimmed(input.city)
	const region = optionalTrimmed(input.region)
	const postal = normalizePostal(country, input.postal)
	const cityKey = normalizePlace(city)
	const regionKey = normalizePlace(region)
	const ipCoords = parseCoordinatePair(input.latitude, input.longitude)

	if (ipCoords) {
		return { ...ipCoords, city, region, precision: 'ip' }
	}

	if (country === 'US' && postal) {
		const coords = pair(datasets.postal[postal])
		if (coords) {
			return { ...coords, city, region, precision: 'postal' }
		}
	}

	if (country && cityKey) {
		const qualified = regionKey
			? pair(datasets.cities[`${cityKey}|${country}|${regionKey}`])
			: null
		const coords = qualified ?? pair(datasets.cities[`${cityKey}|${country}`])
		if (coords) {
			return { ...coords, city, region, precision: 'city' }
		}
	}

	if (country && regionKey) {
		const coords = pair(datasets.regions[`${country}|${regionKey}`])
		if (coords) {
			return { ...coords, city, region, precision: 'region' }
		}
	}

	if (country) {
		const coords = pair(datasets.countries[country])
		if (coords) {
			return { ...coords, city: null, region: null, precision: 'country' }
		}
	}

	return null
}

/**
 * Stripe billing is the card address. Keep it only when it agrees with the
 * purchase country, which is IP/PPP country. A US card on a TH sale must not
 * move the ping to Texas.
 */
export function billingAddressForPurchase(
	purchaseCountry: string | null,
	address: StripeBillingAddress | null | undefined
): StripeBillingAddress | null {
	const country = normalizeCountryCode(purchaseCountry)
	const billingCountry = normalizeCountryCode(address?.country)
	if (!country || !address || billingCountry !== country) return null
	return {
		city: optionalTrimmed(address.city),
		region: optionalTrimmed(address.region),
		postal: optionalTrimmed(address.postal),
		country,
	}
}

/**
 * Country-only caches must not stick. They would block a later ZIP/city fill.
 */
export function readCachedGlobeLocation(fields: unknown): GlobeLocation | null {
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
		return null
	}
	const parsed = CachedGlobeLocationSchema.safeParse(
		(fields as { globe?: unknown }).globe
	)
	if (!parsed.success || parsed.data.precision === 'country') return null
	return {
		lat: parsed.data.lat,
		lng: parsed.data.lng,
		city: parsed.data.city ?? null,
		region: parsed.data.region ?? null,
		precision: parsed.data.precision,
	}
}

export function globeFieldsPatch(
	fields: unknown,
	location: GlobeLocation,
	source: GlobeSource = 'stripe-billing'
): Record<string, unknown> {
	const current =
		fields && typeof fields === 'object' && !Array.isArray(fields)
			? { ...(fields as Record<string, unknown>) }
			: {}
	current.globe = {
		lat: location.lat,
		lng: location.lng,
		city: location.city,
		region: location.region,
		precision: location.precision,
		source,
	}
	return current
}

export type PurchaseGeoWritePlan = Readonly<{
	skip: boolean
	reason: string | null
	city: string | null
	state: string | null
	ipAddress: string | null
	location: GlobeLocation | null
	source: GlobeSource | null
}>

/**
 * Decide what to write onto a purchase from Vercel metadata and Stripe billing.
 * Country-only pings are not cached. Billing is ignored when its country
 * disagrees with the purchase country.
 */
export function planPurchaseGeoWrite(
	input: {
		country: string | null
		city?: string | null
		state?: string | null
		ipAddress?: string | null
		fields?: unknown
		metadata?: CheckoutGeoMetadata | null
		billing?: StripeBillingAddress | null
	},
	datasets?: GlobeGeoDatasets
): PurchaseGeoWritePlan {
	const cached = readCachedGlobeLocation(input.fields)
	if (cached) {
		return {
			skip: true,
			reason: 'already-written',
			city: optionalTrimmed(input.city),
			state: optionalTrimmed(input.state),
			ipAddress: normalizeIpAddress(input.ipAddress),
			location: cached,
			source: null,
		}
	}

	const matched = billingAddressForPurchase(input.country, input.billing)
	const city =
		optionalTrimmed(input.metadata?.city) ??
		optionalTrimmed(input.city) ??
		matched?.city ??
		null
	const state =
		optionalTrimmed(input.metadata?.region) ??
		optionalTrimmed(input.state) ??
		matched?.region ??
		null
	const ipAddress =
		normalizeIpAddress(input.metadata?.ip_address) ??
		normalizeIpAddress(input.ipAddress)
	const location = resolveGlobeLocation(
		{
			country: input.country,
			city,
			region: state,
			postal: matched?.postal,
			latitude: input.metadata?.latitude,
			longitude: input.metadata?.longitude,
		},
		datasets
	)
	const persistable =
		location && location.precision !== 'country' ? location : null
	const source: GlobeSource | null = persistable
		? persistable.precision === 'ip'
			? 'vercel'
			: matched
				? 'stripe-billing'
				: 'vercel'
		: null
	const cityChanged = Boolean(city && city !== optionalTrimmed(input.city))
	const stateChanged = Boolean(state && state !== optionalTrimmed(input.state))
	const ipChanged = Boolean(
		ipAddress && ipAddress !== normalizeIpAddress(input.ipAddress)
	)
	const globeChanged = Boolean(persistable && !cached)

	if (!cityChanged && !stateChanged && !ipChanged && !globeChanged) {
		return {
			skip: true,
			reason: persistable || city || state || ipAddress
				? 'already-written'
				: 'nothing-to-write',
			city,
			state,
			ipAddress,
			location: persistable,
			source,
		}
	}

	return {
		skip: false,
		reason: null,
		city,
		state,
		ipAddress,
		location: persistable,
		source,
	}
}

