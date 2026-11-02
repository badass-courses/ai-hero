import { log } from '@/server/logger'
import { z } from 'zod'

import { getTotalSubscribers } from './kit-data'
import { parseDrovrSignupDeliveryConfig } from './subscriber-marketing/drovr-doi-signup'

type Env = Record<string, string | undefined>
const TENANT = 'org-aihero'

/** Default off. The only reader of AIH_SUBSCRIBER_COUNT_OWNED_ENABLED. */
export function subscriberCountOwnedEnabled(env: Env = process.env): boolean {
	return env.AIH_SUBSCRIBER_COUNT_OWNED_ENABLED === 'true'
}

// drovr's AudienceTotalOutput. A refusal (403/503) or any other shape is
// unavailable, never a zero.
const AudienceTotal = z.object({
	asOf: z.string().datetime({ offset: true }),
	tenantId: z.literal(TENANT),
	total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

function unavailable(reason: string, status?: number): null {
	void log.warn('subscriber_count.owned.unavailable', {
		reason,
		...(status === undefined ? {} : { status }),
	})
	return null
}

/**
 * AI Hero's mailable audience from drovr's census (`GET /audience-total`).
 * `asOf` is the census start and can be about 42 hours old.
 *
 * Same contract as [[src/lib/kit-data.ts#getTotalSubscribers]]: cached
 * 30 min, `null` when unconfigured, refused, timed out (5 s), malformed or
 * implausibly small (< 1000). Logs one line per unavailable read. Never throws.
 */
export async function getOwnedTotalSubscribers(
	args: { env?: Env; fetcher?: typeof fetch } = {},
): Promise<number | null> {
	const config = parseDrovrSignupDeliveryConfig(args.env ?? process.env)
	if (!config) return unavailable('drovr credentials are not configured')

	const fetcher = args.fetcher ?? fetch
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 5_000)
	try {
		const response = await fetcher(`${config.baseUrl}/audience-total`, {
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${config.apiKey}`,
			},
			next: { revalidate: 1800 }, // cache 30 min, like the Kit read
			signal: controller.signal,
		})
		if (!response.ok)
			return unavailable('drovr audience-total refused', response.status)
		const parsed = AudienceTotal.safeParse(await response.json())
		if (!parsed.success)
			return unavailable('drovr audience-total response is invalid')
		if (parsed.data.total < 1000)
			return unavailable('drovr audience-total is implausibly small')
		return parsed.data.total
	} catch {
		return unavailable(
			controller.signal.aborted
				? 'drovr audience-total timed out'
				: 'drovr audience-total read failed',
		)
	} finally {
		clearTimeout(timer)
	}
}

/** The public subscriber total: drovr's census with the flag on, Kit off. */
export async function getPublicSubscriberTotal(
	args: { env?: Env; fetcher?: typeof fetch } = {},
): Promise<number | null> {
	return subscriberCountOwnedEnabled(args.env)
		? getOwnedTotalSubscribers(args)
		: getTotalSubscribers()
}
