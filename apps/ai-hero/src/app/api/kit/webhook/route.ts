import { createHmac, timingSafeEqual } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { db } from '@/db'
import { providerIdentity } from '@/db/schema'
import { env } from '@/env.mjs'
import {
	DROVR_EVENTS_DELIVER_EVENT,
	type DrovrEventsDeliver,
} from '@/inngest/events/drovr'
import { CONTACT_UNSUBSCRIBED_EVENT } from '@/inngest/events/contact-unsubscribed'
import { inngest } from '@/inngest/inngest.server'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
	type DrovrShadowEvent,
} from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { and, eq } from 'drizzle-orm'

/**
 * Kit -> ai-hero -> drovr: a subscriber who unsubscribes, bounces, or
 * complains inside Kit stops their journeys here, not only at the next send.
 *
 * This is a Kit webhook endpoint (the current generation, `Kit-Webhooks/2.0`):
 * every delivery is signed with the endpoint secret over the raw body, carries
 * an `events` array of up to 100 same-typed events, and is retried on any
 * non-2xx. So the body is trusted once the signature checks out, each event is
 * handled by its own UUID so a retried delivery cannot double-fire, and the
 * endpoint acknowledges as soon as the internal events are queued.
 *
 * The internal contact-unsubscribed event already lands in the ContactEvent
 * log, which dispatches contact.unsubscribed to drovr for both journeys and
 * fans it out to the authority tenant for drovr-owned contacts.
 *
 * Docs: https://developers.kit.com/webhooks/delivery-format and
 * https://developers.kit.com/webhooks/verifying-signatures
 */

const STOPPING_EVENTS = [
	'subscriber.unsubscribed',
	'subscriber.bounced',
	'subscriber.complained',
] as const
type StoppingEvent = (typeof STOPPING_EVENTS)[number]

const DIRECTORY_EVENT_TYPES = {
	'subscriber.activated': 'contact.confirmed',
	'subscriber.bounced': 'contact.bounced',
	'subscriber.complained': 'contact.bounced',
	'subscriber.confirmed': 'contact.confirmed',
	'subscriber.unsubscribed': 'contact.unsubscribed',
} as const satisfies Record<string, DrovrShadowEvent['type']>
type DirectoryEventType = (typeof DIRECTORY_EVENT_TYPES)[keyof typeof DIRECTORY_EVENT_TYPES]

/** A Kit unsubscribe is account-wide: every preference the site knows goes with it. */
const PREFERENCE_KEYS = ['newsletter', 'ai-skills'] as const

/** Seconds a delivery's signing timestamp may drift before it is treated as a replay. */
const SIGNATURE_TOLERANCE_SECONDS = 300

type KitEvent = {
	id: string
	type: string
	created: string
	data: {
		subscriber?: { id?: unknown; email_address?: unknown; state?: unknown }
	}
}

const isStoppingEvent = (value: string): value is StoppingEvent =>
	STOPPING_EVENTS.some((event) => event === value)

const directoryEventTypeFor = (value: string): DirectoryEventType | undefined =>
	DIRECTORY_EVENT_TYPES[value as keyof typeof DIRECTORY_EVENT_TYPES]

/**
 * `X-Kit-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]` where each v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`). Several v1 entries appear during a
 * secret rotation; any one matching is enough.
 */
export const validKitSignature = (
	rawBody: string,
	header: string | null,
	secret: string,
	nowSeconds = Date.now() / 1000,
): boolean => {
	const parts = (header ?? '').split(',').map((part) => part.trim())
	const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2)
	if (!timestamp || !/^\d+$/u.test(timestamp)) return false
	if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
		return false
	}
	const expected = Buffer.from(
		createHmac('sha256', secret)
			.update(`${timestamp}.${rawBody}`)
			.digest('hex'),
	)
	return parts
		.filter((part) => part.startsWith('v1='))
		.some((candidate) => {
			const given = Buffer.from(candidate.slice(3))
			return (
				given.length === expected.length && timingSafeEqual(given, expected)
			)
		})
}

const eventsFromBody = (body: unknown): KitEvent[] | undefined => {
	if (typeof body !== 'object' || body === null) return undefined
	const events = (body as { events?: unknown }).events
	if (!Array.isArray(events)) return undefined
	const parsed: KitEvent[] = []
	for (const event of events) {
		if (typeof event !== 'object' || event === null) return undefined
		const { id, type, created, data } = event as Record<string, unknown>
		if (typeof id !== 'string' || typeof type !== 'string') return undefined
		parsed.push({
			id,
			type,
			created: typeof created === 'string' ? created : new Date().toISOString(),
			data:
				typeof data === 'object' && data !== null
					? (data as KitEvent['data'])
					: {},
		})
	}
	return parsed
}

const subscriberOf = (event: KitEvent) => {
	const subscriber = event.data.subscriber
	if (!subscriber) return undefined
	const id =
		typeof subscriber.id === 'number' && Number.isInteger(subscriber.id)
			? String(subscriber.id)
			: typeof subscriber.id === 'string'
				? subscriber.id
				: undefined
	if (!id) return undefined
	return {
		id,
		email:
			typeof subscriber.email_address === 'string'
				? subscriber.email_address
				: undefined,
		state: typeof subscriber.state === 'string' ? subscriber.state : 'unknown',
	}
}

const directoryEventFor = (args: {
	event: KitEvent
	subscriber: NonNullable<ReturnType<typeof subscriberOf>>
	contactId: string
	type: DirectoryEventType
}): DrovrShadowEvent => ({
	tenantId: DROVR_AUTHORITY_TENANT_ID,
	contactId: args.contactId,
	journeyId: DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
	type: args.type,
	occurredAt: args.event.created,
	idempotencyKey: `directory:kit-state:${args.subscriber.id}:${args.type.slice('contact.'.length)}`,
})

const findDirectoryContactId = async (
	kitSubscriberId: string,
): Promise<string | undefined> => {
	const rows = await db
		.select({ contactId: providerIdentity.contactId })
		.from(providerIdentity)
		.where(
			and(
				eq(providerIdentity.provider, 'kit'),
				eq(providerIdentity.externalId, kitSubscriberId),
			),
		)
		.limit(1)
	return rows[0]?.contactId
}

export const POST = withSkill(async (req: NextRequest) => {
	const secret = env.KIT_WEBHOOK_SECRET
	if (!secret) {
		await log.warn('kit.webhook.unverifiable', {
			reason: 'KIT_WEBHOOK_SECRET missing',
		})
		return Response.json({ error: 'cannot verify' }, { status: 503 })
	}
	const rawBody = await req.text()
	if (!validKitSignature(rawBody, req.headers.get('x-kit-signature'), secret)) {
		return Response.json({ error: 'bad signature' }, { status: 401 })
	}

	let body: unknown
	try {
		body = JSON.parse(rawBody)
	} catch {
		return Response.json({ error: 'malformed body' }, { status: 400 })
	}
	const events = eventsFromBody(body)
	if (!events) {
		return Response.json({ error: 'no events' }, { status: 400 })
	}
	const deliveryId = req.headers.get('x-kit-delivery')

	const captured: string[] = []
	const skipped: string[] = []
	for (const event of events) {
		const subscriber = subscriberOf(event)
		const stopping = isStoppingEvent(event.type)
		const directoryType = directoryEventTypeFor(event.type)
		const canCapturePreference =
			stopping &&
			subscriber?.email !== undefined &&
			subscriber.state !== 'active'
		const canCaptureDirectory =
			subscriber !== undefined &&
			directoryType !== undefined &&
			(!stopping || subscriber.state !== 'active')

		if (!canCapturePreference && !canCaptureDirectory) {
			skipped.push(event.id)
			continue
		}

		let queued = false
		if (
			stopping &&
			subscriber &&
			typeof subscriber.email === 'string' &&
			subscriber.state !== 'active'
		) {
			// Inngest dedupes on `id`, so a retried delivery or a re-emitted event
			// cannot unsubscribe twice.
			const email = subscriber.email
			await inngest.send(
				PREFERENCE_KEYS.map((preferenceKey) => ({
					id: `kit-webhook:${event.id}:${preferenceKey}`,
					name: CONTACT_UNSUBSCRIBED_EVENT,
					data: {
						email,
						kitSubscriberId: subscriber.id,
						preferenceKey,
						source: `kit-webhook:${event.type}`,
						occurredAt: event.created,
					},
				})),
			)
			queued = true
		}

		if (canCaptureDirectory && subscriber && directoryType) {
			const contactId = await findDirectoryContactId(subscriber.id)
			if (contactId) {
				const directoryEvent = directoryEventFor({
					event,
					subscriber,
					contactId,
					type: directoryType,
				})
				const delivery: DrovrEventsDeliver & { id: string } = {
					id: `kit-directory:${event.id}:${directoryEvent.type}`,
					name: DROVR_EVENTS_DELIVER_EVENT,
					data: {
						events: [directoryEvent],
						source: 'kit-webhook' as const,
					},
				}
				await inngest.send(delivery)
				queued = true
			} else {
				await log.warn('kit.webhook.directory_contact_missing', {
					deliveryId,
					eventId: event.id,
					kitEvent: event.type,
					kitSubscriberId: subscriber.id,
				})
			}
		}

		if (!queued) {
			skipped.push(event.id)
			continue
		}
		await log.info('kit.webhook.captured', {
			deliveryId,
			eventId: event.id,
			kitEvent: event.type,
			kitSubscriberId: subscriber?.id,
			state: subscriber?.state,
		})
		captured.push(event.id)
	}
	if (skipped.length > 0) {
		await log.info('kit.webhook.ignored', {
			deliveryId,
			eventIds: skipped,
			kitEvent: events[0]?.type,
		})
	}
	return Response.json({ captured: captured.length, ignored: skipped.length })
})
