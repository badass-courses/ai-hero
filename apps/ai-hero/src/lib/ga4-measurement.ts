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

export type GA4SendStatus = 'sent' | 'skipped_missing_config' | 'failed'

export interface GA4SendReceipt {
	status: GA4SendStatus
	eventNames: string[]
	eventCount: number
	httpStatus?: number
	reason?: string
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

function receipt(
	payload: GA4MeasurementPayload,
	status: GA4SendStatus,
	extra: Pick<GA4SendReceipt, 'httpStatus' | 'reason'> = {},
): GA4SendReceipt {
	return {
		status,
		eventNames: payload.events.map((event) => event.name),
		eventCount: payload.events.length,
		...extra,
	}
}

/**
 * POST to GA4 Measurement Protocol and return a safe receipt.
 * Never throws. Callers can keep user flows non-blocking while still logging
 * whether GA4 accepted, skipped, or failed the attempt.
 *
 * @param payload - GA4 measurement payload with client_id and events
 */
export async function sendGA4Event(
	payload: GA4MeasurementPayload,
): Promise<GA4SendReceipt> {
	const measurementId = getMeasurementId()
	const apiSecret = getApiSecret()

	if (!measurementId || !apiSecret) {
		return receipt(payload, 'skipped_missing_config', {
			reason: 'GA4 Measurement Protocol config missing',
		})
	}

	const url = new URL(GA4_COLLECT_URL)
	url.searchParams.set('measurement_id', measurementId)
	url.searchParams.set('api_secret', apiSecret)

	try {
		const response = await fetch(url.toString(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})

		if (!response.ok) {
			return receipt(payload, 'failed', {
				httpStatus: response.status,
				reason: `GA4 Measurement Protocol returned HTTP ${response.status}`,
			})
		}

		return receipt(payload, 'sent', { httpStatus: response.status })
	} catch (error) {
		return receipt(payload, 'failed', {
			reason: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * Parse a _ga cookie value into the client_id format expected by GA4 MP.
 * Cookie format: 'GA1.1.XXXX.XXXX' returns 'XXXX.XXXX'.
 * Already-normalized values like 'XXXX.XXXX' pass through unchanged.
 * Falls back to crypto.randomUUID() if the format doesn't match.
 *
 * @param gaCookieValue - raw value from the _ga cookie or a normalized client ID
 */
export function extractGA4ClientId(gaCookieValue: string | undefined): string {
	if (!gaCookieValue) {
		return crypto.randomUUID()
	}

	if (/^\d+\.\d+$/.test(gaCookieValue)) {
		return gaCookieValue
	}

	// _ga cookie: GA1.1.<random>.<timestamp>
	const parts = gaCookieValue.split('.')
	if (parts.length >= 4 && parts[2] && parts[3]) {
		return `${parts[2]}.${parts[3]}`
	}

	return crypto.randomUUID()
}
