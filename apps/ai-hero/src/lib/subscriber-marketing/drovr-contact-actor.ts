import type { DrovrActorRead } from './owner-birth-guard'

/**
 * drovr's `GET /contacts?contact=&journey=`: one contact's actor snapshot
 * on one journey. 200 carries `stateName`; 404 `contact-not-found` means
 * drovr holds no actor snapshot, so the contact was never born there.
 * Anything else (another 404, an error, an unknown shape) is unreadable and
 * never guessed into an answer.
 */
const CONTACT_NOT_FOUND = 'urn:drovr:problem:contact-not-found'

export async function readDrovrContactActor(args: {
	contactId: string
	journeyId: string
	config: { baseUrl: string | undefined; apiKey: string | undefined }
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<DrovrActorRead> {
	const { baseUrl, apiKey } = args.config
	if (!baseUrl || !apiKey)
		return { ok: false, reason: 'drovr is not configured' }
	const url = `${baseUrl.replace(/\/+$/, '')}/contacts?contact=${encodeURIComponent(args.contactId)}&journey=${encodeURIComponent(args.journeyId)}`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000)
	try {
		const response = await (args.fetcher ?? fetch)(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			signal: controller.signal,
		})
		// Shed status is authoritative even if the body is malformed or stalls.
		if (
			response.status === 429 ||
			response.status === 502 ||
			response.status === 503 ||
			response.status === 504
		)
			return {
				ok: false,
				reason: `drovr answered ${response.status}`,
				backpressure: {
					status: response.status,
					retryAfter: response.headers.get('retry-after') ?? undefined,
				},
			}
		if (response.status >= 500 && response.status < 600)
			return {
				ok: false,
				reason: `drovr answered ${response.status}`,
				backpressure: {
					status: '5xx',
					retryAfter: response.headers.get('retry-after') ?? undefined,
				},
			}
		const body: unknown = await response.json()
		const record =
			body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
		if (response.status === 404 && record.type === CONTACT_NOT_FOUND)
			return { ok: true, found: false }
		if (response.status !== 200)
			return { ok: false, reason: `drovr answered ${response.status}` }
		if (typeof record.stateName !== 'string')
			return { ok: false, reason: 'drovr answered an unknown actor shape' }
		return { ok: true, found: true, stateName: record.stateName }
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
			...(controller.signal.aborted ||
			(error instanceof Error &&
				(error.name === 'AbortError' || error.name === 'TimeoutError'))
				? { backpressure: { status: 'timeout' as const } }
				: {}),
		}
	} finally {
		clearTimeout(timeout)
	}
}
