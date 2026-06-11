// ─── Types ───────────────────────────────────────────────────────────────────

export interface GA4EventParam {
	[key: string]: string | number | boolean | undefined
}

export interface GA4Event {
	name: string
	params?: GA4EventParam
}

export interface GA4MeasurementPayload {
	client_id: string
	user_id?: string
	events: GA4Event[]
}

// ─── Config ──────────────────────────────────────────────────────────────────

const GA4_COLLECT_URL = 'https://www.google-analytics.com/mp/collect'

function getMeasurementId(): string | undefined {
	return process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS
}

function getApiSecret(): string | undefined {
	return process.env.GA4_MEASUREMENT_API_SECRET
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget POST to GA4 Measurement Protocol.
 * Never throws — logs errors silently so callers don't need try/catch.
 *
 * @param payload - GA4 measurement payload with client_id and events
 */
export async function sendGA4Event(
	payload: GA4MeasurementPayload,
): Promise<void> {
	const measurementId = getMeasurementId()
	const apiSecret = getApiSecret()

	if (!measurementId || !apiSecret) {
		return
	}

	const url = new URL(GA4_COLLECT_URL)
	url.searchParams.set('measurement_id', measurementId)
	url.searchParams.set('api_secret', apiSecret)

	try {
		await fetch(url.toString(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})
	} catch {
		// fire-and-forget — never surface errors to callers
	}
}

/**
 * Parse a _ga cookie value into the client_id format expected by GA4 MP.
 * Cookie format: 'GA1.1.XXXX.XXXX' → returns 'XXXX.XXXX'
 * Falls back to crypto.randomUUID() if the format doesn't match.
 *
 * @param gaCookieValue - raw value from the _ga cookie
 */
export function extractGA4ClientId(gaCookieValue: string | undefined): string {
	if (!gaCookieValue) {
		return crypto.randomUUID()
	}

	// _ga cookie: GA1.1.<random>.<timestamp>
	const parts = gaCookieValue.split('.')
	if (parts.length >= 4) {
		return `${parts[2]}.${parts[3]}`
	}

	return crypto.randomUUID()
}
