import 'server-only'

import { db } from '@/db'
import { purchases } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'

import type { PurchaseTickerHit } from './admin-sales-globe-contract'
import {
	billingAddressForPurchase,
	globeFieldsPatch,
	planPurchaseGeoWrite,
	resolveGlobeLocation,
	type CheckoutGeoMetadata,
	type PurchaseGeoWritePlan,
	type StripeBillingAddress,
} from './admin-sales-globe-geo'

export const STRIPE_GEO_ENRICH_LIMIT = 24
const STRIPE_GEO_CONCURRENCY = 6

export type GlobeEnrichmentRow = Readonly<{
	id: string
	country: string | null
	city?: string | null
	state?: string | null
	ipAddress?: string | null
	fields: unknown
	sessionIdentifier: string | null
	chargeIdentifier: string | null
}>

type StripeAddressLike = {
	city?: string | null
	state?: string | null
	postal_code?: string | null
	country?: string | null
}

/**
 * Stripe Checkout and Charge addresses share this shape.
 */
export function stripeAddressFromFields(
	address: StripeAddressLike | null | undefined
): StripeBillingAddress | null {
	if (!address) return null
	const city = address.city?.trim() || null
	const region = address.state?.trim() || null
	const postal = address.postal_code?.trim() || null
	const country = address.country?.trim() || null
	if (!city && !region && !postal && !country) return null
	return { city, region, postal, country }
}

export async function readStripeBillingAddress({
	sessionIdentifier,
	chargeIdentifier,
	stripe,
}: {
	sessionIdentifier: string | null
	chargeIdentifier: string | null
	stripe: Stripe
}): Promise<StripeBillingAddress | null> {
	const geo = await readStripeCheckoutGeo({
		sessionIdentifier,
		chargeIdentifier,
		stripe,
	})
	return geo.address
}

function checkoutGeoFromStripeMetadata(
	metadata: Stripe.Metadata | null | undefined
): CheckoutGeoMetadata {
	if (!metadata) return {}
	return {
		city: metadata.city ?? null,
		region: metadata.region ?? null,
		latitude: metadata.latitude ?? null,
		longitude: metadata.longitude ?? null,
		ip_address: metadata.ip_address ?? null,
	}
}

/**
 * Checkout billing plus session metadata (Vercel city/region/coords/IP).
 */
export async function readStripeCheckoutGeo({
	sessionIdentifier,
	chargeIdentifier,
	stripe,
}: {
	sessionIdentifier: string | null
	chargeIdentifier: string | null
	stripe: Stripe
}): Promise<{
	address: StripeBillingAddress | null
	metadata: CheckoutGeoMetadata
}> {
	let address: StripeBillingAddress | null = null
	let metadata: CheckoutGeoMetadata = {}

	if (sessionIdentifier?.startsWith('cs_')) {
		try {
			const session = await stripe.checkout.sessions.retrieve(sessionIdentifier)
			address = stripeAddressFromFields(session.customer_details?.address)
			metadata = checkoutGeoFromStripeMetadata(session.metadata)
		} catch {
			// Fall through to the charge. One missing session must not fail the board.
		}
	}

	if (!address && chargeIdentifier) {
		try {
			const charge = await stripe.charges.retrieve(chargeIdentifier)
			address = stripeAddressFromFields(charge.billing_details?.address)
		} catch {
			address = null
		}
	}

	return { address, metadata }
}

function isCountryOnly(hit: PurchaseTickerHit): boolean {
	return hit.lat !== null && hit.lng !== null && !hit.city && !hit.region
}

function canEnrich(hit: PurchaseTickerHit, row: GlobeEnrichmentRow): boolean {
	if (hit.city || hit.region) return false
	if (!row.sessionIdentifier && !row.chargeIdentifier) return false
	return hit.lat === null || isCountryOnly(hit)
}

/**
 * Apply a matching Stripe billing address onto a hit when it is finer than country.
 */
export function applyStripeBillingToHit(
	hit: PurchaseTickerHit,
	address: StripeBillingAddress | null
): PurchaseTickerHit | null {
	const matched = billingAddressForPurchase(hit.country, address)
	if (!matched) return null
	const location = resolveGlobeLocation({
		country: hit.country,
		city: matched.city,
		region: matched.region,
		postal: matched.postal,
	})
	if (!location || location.precision === 'country') return null
	return {
		...hit,
		city: location.city,
		region: location.region,
		lat: location.lat,
		lng: location.lng,
	}
}

async function mapPool<T>(
	items: readonly T[],
	concurrency: number,
	work: (item: T) => Promise<void>
): Promise<void> {
	const queue = [...items]
	const workerCount = Math.min(concurrency, queue.length)
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (queue.length > 0) {
				const item = queue.shift()
				if (item) await work(item)
			}
		})
	)
}

/**
 * Fill country-only pings from Stripe billing. Writes city/state and a globe
 * cache onto the purchase so the next poll does not retrieve Stripe again.
 */
export async function enrichGlobeHitsFromStripe({
	hits,
	rows,
	readBilling,
	persist = persistGlobeLocation,
	limit = STRIPE_GEO_ENRICH_LIMIT,
}: {
	hits: readonly PurchaseTickerHit[]
	rows: readonly GlobeEnrichmentRow[]
	readBilling: (row: GlobeEnrichmentRow) => Promise<StripeBillingAddress | null>
	persist?: (input: {
		row: GlobeEnrichmentRow
		hit: PurchaseTickerHit
	}) => Promise<void>
	limit?: number
}): Promise<PurchaseTickerHit[]> {
	const rowsById = new Map(rows.map((row) => [row.id, row]))
	const nextHits = hits.map((hit) => ({ ...hit }))
	const pending = nextHits.flatMap((hit) => {
		const row = rowsById.get(hit.id)
		return row && canEnrich(hit, row) ? [{ hit, row }] : []
	})
	const batch = pending.slice(0, Math.max(0, limit))

	await mapPool(batch, STRIPE_GEO_CONCURRENCY, async ({ hit, row }) => {
		const address = await readBilling(row)
		const upgraded = applyStripeBillingToHit(hit, address)
		if (!upgraded) return
		hit.city = upgraded.city
		hit.region = upgraded.region
		hit.lat = upgraded.lat
		hit.lng = upgraded.lng
		try {
			await persist({ row, hit })
		} catch {
			// The in-memory ping still upgrades. A persist miss retries next poll.
		}
	})

	return nextHits
}

async function persistGlobeLocation({
	row,
	hit,
}: {
	row: GlobeEnrichmentRow
	hit: PurchaseTickerHit
}): Promise<void> {
	if (hit.lat === null || hit.lng === null) return
	const location = {
		lat: hit.lat,
		lng: hit.lng,
		city: hit.city,
		region: hit.region,
		precision:
			hit.city && hit.region
				? ('city' as const)
				: hit.city
					? ('city' as const)
					: hit.region
						? ('region' as const)
						: ('postal' as const),
	}
	await db
		.update(purchases)
		.set({
			...(hit.city ? { city: hit.city } : {}),
			...(hit.region ? { state: hit.region } : {}),
			fields: globeFieldsPatch(row.fields, location),
		})
		.where(eq(purchases.id, hit.id))
}

/**
 * Write a planned city/state/IP/globe cache onto one purchase.
 */
export async function persistPurchaseGeoWrite({
	purchaseId,
	fields,
	plan,
}: {
	purchaseId: string
	fields: unknown
	plan: PurchaseGeoWritePlan
}): Promise<void> {
	if (plan.skip) {
		if (plan.reason === 'nothing-to-write') {
			const current =
				fields && typeof fields === 'object' && !Array.isArray(fields)
					? { ...(fields as Record<string, unknown>) }
					: {}
			current.globeAttempted = true
			await db
				.update(purchases)
				.set({ fields: current })
				.where(eq(purchases.id, purchaseId))
		}
		return
	}
	await db
		.update(purchases)
		.set({
			...(plan.city ? { city: plan.city } : {}),
			...(plan.state ? { state: plan.state } : {}),
			...(plan.ipAddress ? { ipAddress: plan.ipAddress } : {}),
			...(plan.location && plan.source
				? {
						fields: globeFieldsPatch(
							fields,
							plan.location,
							plan.source
						),
					}
				: {}),
		})
		.where(eq(purchases.id, purchaseId))
}

/**
 * Fill one purchase from Stripe session metadata and matching billing.
 */
export async function persistPurchaseGeoFromStripe({
	row,
	readGeo,
	persist = persistPurchaseGeoWrite,
}: {
	row: GlobeEnrichmentRow
	readGeo: (row: GlobeEnrichmentRow) => Promise<{
		address: StripeBillingAddress | null
		metadata: CheckoutGeoMetadata
	}>
	persist?: (input: {
		purchaseId: string
		fields: unknown
		plan: PurchaseGeoWritePlan
	}) => Promise<void>
}): Promise<PurchaseGeoWritePlan> {
	const already = planPurchaseGeoWrite({
		country: row.country,
		city: row.city ?? null,
		state: row.state ?? null,
		ipAddress: row.ipAddress ?? null,
		fields: row.fields,
	})
	if (already.skip && already.reason === 'already-written') {
		return already
	}

	const geo = await readGeo(row)
	const plan = planPurchaseGeoWrite({
		country: row.country,
		city: row.city ?? null,
		state: row.state ?? null,
		ipAddress: row.ipAddress ?? null,
		fields: row.fields,
		metadata: geo.metadata,
		billing: geo.address,
	})
	if (!plan.skip || plan.reason === 'nothing-to-write') {
		await persist({ purchaseId: row.id, fields: row.fields, plan })
	}
	return plan
}
