import { ATTRIBUTION_METADATA_MAX_LENGTH } from '@coursebuilder/core/lib/checkout-attribution'

type CheckoutAttribution = {
	attributionSnapshot?: string
	[key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCheckoutKitSubscriberId(value?: string | null) {
	const trimmed = value?.trim()
	if (!trimmed) return undefined
	try {
		const parsed = JSON.parse(trimmed) as unknown
		if (typeof parsed === 'string' || typeof parsed === 'number') {
			return String(parsed).trim().slice(0, 255) || undefined
		}
	} catch {
		// URL-param cookies are already plain strings.
	}
	return trimmed.slice(0, 255)
}

function parseSnapshot(value?: string) {
	if (!value) return {}
	try {
		const parsed = JSON.parse(value) as unknown
		return isRecord(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

function firstBoundedSnapshot(candidates: Record<string, unknown>[]) {
	for (const candidate of candidates) {
		const json = JSON.stringify(candidate)
		if (json.length <= ATTRIBUTION_METADATA_MAX_LENGTH) return json
	}
	throw new Error(
		'Kit subscriber attribution snapshot exceeds Stripe metadata limit',
	)
}

/** Add the existing Kit identity to the Stripe-bound checkout snapshot. */
export function addKitSubscriberToCheckoutAttribution(args: {
	checkoutAttribution: CheckoutAttribution
	rawSubscriberId?: string | null
	now?: () => Date
}) {
	const kitSubscriberId = normalizeCheckoutKitSubscriberId(args.rawSubscriberId)
	if (!kitSubscriberId) return args.checkoutAttribution

	const snapshot = parseSnapshot(args.checkoutAttribution.attributionSnapshot)
	const capturedAt =
		typeof snapshot.capturedAt === 'string'
			? snapshot.capturedAt
			: (args.now ?? (() => new Date()))().toISOString()
	const identity = { kitSubscriberId }
	const synthetic = snapshot.synthetic
		? {
				synthetic: snapshot.synthetic,
				syntheticReason: snapshot.syntheticReason,
			}
		: {}
	const attributionSnapshot = firstBoundedSnapshot([
		{
			...snapshot,
			schemaVersion: snapshot.schemaVersion ?? 1,
			capturedAt,
			...identity,
		},
		{
			schemaVersion: snapshot.schemaVersion ?? 1,
			capturedAt,
			...synthetic,
			utm: snapshot.utm,
			clickIds: snapshot.clickIds,
			...identity,
		},
		{
			schemaVersion: snapshot.schemaVersion ?? 1,
			capturedAt,
			...synthetic,
			clickIds: snapshot.clickIds,
			...identity,
		},
		{ schemaVersion: 1, capturedAt, ...identity },
	])

	return { ...args.checkoutAttribution, attributionSnapshot }
}
