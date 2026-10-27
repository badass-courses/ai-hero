import { z } from 'zod'

const StopsReply = z.object({
	kitSubscriberId: z.string(),
	tenantId: z.string().optional(),
	contactId: z.string().nullable().optional(),
	stops: z.array(
		z.object({
			scope: z.literal('all'),
			// Unknown future stop reasons must never become DOI consent.
			reason: z.string().min(1),
			createdAt: z.string().optional(),
		}),
	),
})

/** Server p95 is ~0.7s; the old 3s budget was overrun client-side (cold connection/TLS per request). */
export const DROVR_READ_BUDGET_MS = 6000

export type DrovrReadObservation = { ms: number; status: number | 'error' }

/**
 * Read-only org-aihero contract: one `GET /kit-subscriber-stops` returns the
 * subscriber's active all-scope stops. An empty list means clear. Anything
 * else (503, 403, timeout, malformed body, mismatched id) throws, which the
 * caller treats as unknown and defers; it is never read as "no stop".
 */
export async function readDrovrOptOuts(
	kitSubscriberId: string,
	config:
		| {
				baseUrl: string
				apiKey: string
				fetch?: typeof fetch
				/** Called once per request with latency and HTTP status. */
				onRead?: (observation: DrovrReadObservation) => void | Promise<void>
		  }
		| undefined,
): Promise<{ reason: string }[]> {
	if (!config) throw new Error('Drovr opt-out reader is not configured')
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	// One 6s budget covers the request and its body. No retries.
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new DOMException('Drovr opt-out read timed out', 'TimeoutError'))
		}, DROVR_READ_BUDGET_MS)
	})
	const fetcher = config.fetch ?? fetch
	const baseUrl = config.baseUrl.replace(/\/$/, '')
	const started = Date.now()
	let status: number | 'error' = 'error'
	const lookup = async () => {
		const query = new URLSearchParams({ kitSubscriberId })
		const response = await fetcher(`${baseUrl}/kit-subscriber-stops?${query}`, {
			method: 'GET',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				accept: 'application/json',
			},
			signal: controller.signal,
		})
		status = response.status
		if (!response.ok) throw new Error('Drovr opt-out read failed')
		const reply = StopsReply.parse(await response.json())
		if (reply.kitSubscriberId !== kitSubscriberId) {
			throw new TypeError('Unexpected drovr subscriber id')
		}
		return reply.stops.map(({ reason }) => ({ reason }))
	}
	try {
		return await Promise.race([lookup(), deadline])
	} finally {
		clearTimeout(timer)
		try {
			await config.onRead?.({ ms: Date.now() - started, status })
		} catch {}
	}
}
