/**
 * drovr's `get_email_delivery` (drovr #412): did drovr deliver a value-path
 * email to a contact, when, and through which provider. A cheap tenant-key
 * read (three point reads, never wakes the actor):
 *
 * - `delivered`: drovr holds the email's completion (PostShiba's delivered
 *   webhook stamps `provider: postshiba`).
 * - `pending`: pinned to PostShiba with value-path history, not delivered.
 * - `not-routed`: pinned to Kit or never pinned; the Kit path owns it.
 * - `not-started`: drovr has no value-path receipt for the contact.
 *
 * Anything else (an error, a refusal, an unknown shape) is unreadable and
 * never guessed into an answer.
 */

import type { DrovrReadFailure } from './owner-birth-guard'

export type DrovrEmailDeliveryStatus =
	| 'delivered'
	| 'pending'
	| 'not-routed'
	| 'not-started'

export type DrovrEmailDelivery = {
	status: DrovrEmailDeliveryStatus
	route: string | null
	deliveredAt: string | null
	provider: string | null
}

export type DrovrEmailDeliveryRead =
	| { ok: true; delivery: DrovrEmailDelivery }
	| DrovrReadFailure

export type DrovrEmailDeliveryConfig = {
	baseUrl: string | undefined
	apiKey: string | undefined
}

const STATUSES: ReadonlySet<string> = new Set([
	'delivered',
	'pending',
	'not-routed',
	'not-started',
])

const nullableString = (value: unknown): string | null =>
	typeof value === 'string' ? value : null

export async function readDrovrEmailDelivery(args: {
	contactId: string
	email: string
	config: DrovrEmailDeliveryConfig
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<DrovrEmailDeliveryRead> {
	const { baseUrl, apiKey } = args.config
	if (!baseUrl || !apiKey)
		return { ok: false, reason: 'drovr is not configured' }
	const url = `${baseUrl.replace(/\/+$/, '')}/email-delivery?contact=${encodeURIComponent(args.contactId)}&email=${encodeURIComponent(args.email)}`
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
		if (response.status !== 200) {
			return {
				ok: false,
				reason: `drovr answered ${response.status}`,
				...(response.status === 429 ||
				response.status === 502 ||
				response.status === 503 ||
				response.status === 504
					? {
							backpressure: {
								status: response.status,
								retryAfter: response.headers.get('retry-after') ?? undefined,
							},
						}
					: {}),
			}
		}
		const body: unknown = await response.json()
		const record =
			body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
		if (typeof record.status !== 'string' || !STATUSES.has(record.status)) {
			return { ok: false, reason: 'drovr answered an unknown delivery shape' }
		}
		return {
			ok: true,
			delivery: {
				status: record.status as DrovrEmailDeliveryStatus,
				route: nullableString(record.route),
				deliveredAt: nullableString(record.deliveredAt),
				provider: nullableString(record.provider),
			},
		}
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
