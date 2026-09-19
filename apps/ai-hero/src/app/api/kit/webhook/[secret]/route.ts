import { timingSafeEqual } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { env } from '@/env.mjs'
import { CONTACT_UNSUBSCRIBED_EVENT } from '@/inngest/events/contact-unsubscribed'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'

/**
 * Kit -> ai-hero -> drovr: a subscriber who unsubscribes, bounces, or
 * complains inside Kit stops their journeys here, not only at the next send.
 *
 * Kit v4 webhooks are not signed and the payload does not name the event, so
 * the registered target URL carries a secret path segment and an `event`
 * query, and nothing is trusted from the body: the subscriber is read back
 * from Kit with our key and only a non-active state is acted on. A forged
 * POST can at most make us read one subscriber.
 *
 * Deliberately not wrapped in withSkill: that wrapper logs the request URL
 * verbatim, which would write the secret segment into every log line. This
 * route logs its own structured lines and never the path.
 *
 * The internal contact-unsubscribed event already lands in the ContactEvent
 * log, which dispatches contact.unsubscribed to drovr for both journeys and
 * fans it out to the authority tenant for drovr-owned contacts.
 */

const KIT_EVENTS = [
	'subscriber_unsubscribe',
	'subscriber_bounce',
	'subscriber_complain',
] as const
type KitEvent = (typeof KIT_EVENTS)[number]

/** A Kit unsubscribe is account-wide: every preference the site knows goes with it. */
const PREFERENCE_KEYS = ['newsletter', 'ai-skills'] as const

type KitSubscriber = {
	id: number
	email_address: string
	state: string
}

const isKitEvent = (value: string | null): value is KitEvent =>
	KIT_EVENTS.some((event) => event === value)

const secretMatches = (given: string, expected: string): boolean => {
	const a = Buffer.from(given)
	const b = Buffer.from(expected)
	return a.length === b.length && timingSafeEqual(a, b)
}

const subscriberIdFromBody = (body: unknown): string | undefined => {
	if (typeof body !== 'object' || body === null) return undefined
	const subscriber = (body as { subscriber?: unknown }).subscriber
	if (typeof subscriber !== 'object' || subscriber === null) return undefined
	const id = (subscriber as { id?: unknown }).id
	if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
		return String(id)
	}
	if (typeof id === 'string' && /^\d+$/u.test(id)) return id
	return undefined
}

export async function readKitSubscriber(
	kitSubscriberId: string,
	apiKey: string,
	fetcher: typeof fetch = fetch,
): Promise<KitSubscriber | undefined> {
	const response = await fetcher(
		`https://api.kit.com/v4/subscribers/${encodeURIComponent(kitSubscriberId)}`,
		{ headers: { 'X-Kit-Api-Key': apiKey } },
	)
	if (!response.ok) return undefined
	const payload = (await response.json()) as { subscriber?: KitSubscriber }
	const subscriber = payload.subscriber
	if (
		!subscriber ||
		typeof subscriber.email_address !== 'string' ||
		typeof subscriber.state !== 'string'
	) {
		return undefined
	}
	return subscriber
}

export const POST = withSkill(
	async (req: NextRequest, props: { params: Promise<{ secret: string }> }) => {
		const { secret } = await props.params
		const expected = env.KIT_WEBHOOK_SECRET
		if (!expected || secret !== expected) {
			return Response.json({ error: 'not found' }, { status: 404 })
		}
		const eventParam = req.nextUrl.searchParams.get('event')
		const kitEvent: KitEvent = isKitEvent(eventParam)
			? eventParam
			: 'subscriber_unsubscribe'

		let body: unknown
		try {
			body = await req.json()
		} catch {
			return Response.json({ error: 'malformed body' }, { status: 400 })
		}
		const kitSubscriberId = subscriberIdFromBody(body)
		if (!kitSubscriberId) {
			return Response.json({ error: 'no subscriber id' }, { status: 400 })
		}

		const apiKey = env.KIT_V4_API_KEY
		if (!apiKey) {
			await log.warn('kit.webhook.unverifiable', {
				kitEvent,
				kitSubscriberId,
				reason: 'KIT_V4_API_KEY missing',
			})
			return Response.json({ error: 'cannot verify' }, { status: 503 })
		}
		const subscriber = await readKitSubscriber(kitSubscriberId, apiKey)
		if (!subscriber) {
			await log.warn('kit.webhook.unverifiable', {
				kitEvent,
				kitSubscriberId,
				reason: 'subscriber readback failed',
			})
			return Response.json({ error: 'cannot verify' }, { status: 503 })
		}
		if (subscriber.state === 'active') {
			await log.info('kit.webhook.ignored', {
				kitEvent,
				kitSubscriberId,
				state: subscriber.state,
			})
			return Response.json({ status: 'ignored', state: subscriber.state })
		}

		const occurredAt = new Date().toISOString()
		await inngest.send(
			PREFERENCE_KEYS.map((preferenceKey) => ({
				name: CONTACT_UNSUBSCRIBED_EVENT,
				data: {
					email: subscriber.email_address,
					kitSubscriberId,
					preferenceKey,
					source: `kit-webhook:${kitEvent}`,
					occurredAt,
				},
			})),
		)
		await log.info('kit.webhook.captured', {
			kitEvent,
			kitSubscriberId,
			state: subscriber.state,
			preferenceKeys: PREFERENCE_KEYS.length,
		})
		return Response.json({ status: 'captured', state: subscriber.state })
	},
)
