import { Effect } from 'effect'
import { z } from 'zod'

import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type { SendMessageIntent } from './domain'
import type { DeliveryPort, EffectApplicationError } from './ports'
import { parseContactId, parseIsoInstant } from './primitives'

const providerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const bindingSchema = z.object({
	contentResourceId: z.string().min(1),
	sequenceId: providerId,
	// Supplied by a separately approved provider readback, not manufactured here.
	readback: z.object({
		sequenceId: providerId,
		repeat: z.literal(false),
		emailCount: z.literal(1),
		published: z.literal(true),
		active: z.literal(true),
		hold: z.literal(false),
	}),
})
const identitySchema = z.object({
	contactId: z.string().min(1),
	subscriberId: providerId,
})
const subscriberSchema = z.object({
	id: providerId,
	first_name: z.string().nullable(),
	email_address: z.string().email(),
	state: z.enum(['active', 'cancelled', 'bounced', 'complained', 'inactive']),
	created_at: z.string().datetime({ offset: true }),
	added_at: z.string().datetime({ offset: true }),
	fields: z.record(z.unknown()),
})
const enrollmentSchema = z.object({
	subscriber: subscriberSchema,
	sequence_id: providerId.optional(),
})
const pageSchema = z.object({
	subscribers: z.array(subscriberSchema).max(100),
	pagination: z.object({ has_next_page: z.boolean(), end_cursor: z.string() }),
	truncated: z.literal(false).optional(),
})

export type KitDeliveryOptions = {
	readonly apiKey?: string
	readonly bindings: unknown
	/** Existing identity authority; must not create subscribers or mutate Kit. */
	readonly resolveIdentity: (contactId: string) => Promise<unknown>
	/** Inject a single-attempt transport. SDK transports with implicit retries are not allowed. */
	readonly fetch: typeof fetch
	readonly now: () => string
	readonly timeoutMs?: number
}

export type KitMembership =
	| { readonly type: 'Present'; readonly meaning: 'sequence-membership-only' }
	| {
			readonly type: 'Absent'
			readonly meaning: 'complete-read-not-resend-permission'
	  }
	| { readonly type: 'Unknown'; readonly reason: string }

const refusal = (reason: string): EffectApplicationError => ({
	type: 'EffectPermanentRefusal',
	reason,
})
const ambiguous = (reason: string): EffectApplicationError => ({
	type: 'EffectAmbiguous',
	reason,
})
const messages = [
	...EVERGREEN_OFFER_JOURNEY_V1.bridge,
	...EVERGREEN_OFFER_JOURNEY_V1.pitch,
]

/**
 * Dormant adapter: no env reads, default transport, registration, scheduling, or retries.
 * Kit enrollment is NOT inbox delivery. Durable attempt claims and independent-slot
 * scheduling remain the executor's responsibility, including crash-after-acceptance.
 * Docs: developers.kit.com/api-reference/sequences/add-subscriber-to-sequence
 * and /list-subscribers-for-a-sequence (Kit v4).
 */
export function createKitDeliveryPort(
	options: KitDeliveryOptions,
): DeliveryPort & {
	readonly reconcile: (
		intent: SendMessageIntent,
		maxPages?: number,
	) => Effect.Effect<KitMembership>
} {
	const timeoutMs = options.timeoutMs ?? 5000
	const bounded = <A>(
		work: (signal: AbortSignal) => Promise<A>,
		error: EffectApplicationError,
	) =>
		Effect.tryPromise({ try: work, catch: () => error }).pipe(
			Effect.timeoutFail({ duration: timeoutMs, onTimeout: () => error }),
		)

	const prepare = (intent: SendMessageIntent) =>
		Effect.gen(function* () {
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
				return yield* Effect.fail(refusal('invalid-timeout'))
			}
			const apiKey = options.apiKey?.trim()
			if (!apiKey || /[\r\n]/.test(apiKey))
				return yield* Effect.fail(refusal('missing-or-invalid-credentials'))
			if (!parseContactId(intent.contactId).ok)
				return yield* Effect.fail(refusal('invalid-contact'))
			const approved = messages.find(
				(message) => message.contentResourceId === intent.contentResourceId,
			)
			if (
				!approved ||
				approved.slotId !== intent.slotId ||
				Object.entries(approved.presentation).some(
					([key, value]) => Reflect.get(intent.presentation, key) !== value,
				)
			) {
				return yield* Effect.fail(refusal('unapproved-message-binding'))
			}
			const decoded = z.array(bindingSchema).safeParse(options.bindings)
			if (!decoded.success)
				return yield* Effect.fail(refusal('invalid-sequence-readback'))
			const bindings = decoded.data
			if (
				new Set(bindings.map((item) => item.contentResourceId)).size !==
					bindings.length ||
				new Set(bindings.map((item) => item.sequenceId)).size !==
					bindings.length ||
				bindings.some(
					(item) =>
						item.sequenceId !== item.readback.sequenceId ||
						!messages.some(
							(message) => message.contentResourceId === item.contentResourceId,
						),
				)
			) {
				return yield* Effect.fail(refusal('conflicting-sequence-binding'))
			}
			const binding = bindings.find(
				(item) => item.contentResourceId === intent.contentResourceId,
			)
			if (!binding)
				return yield* Effect.fail(refusal('missing-sequence-binding'))
			const rawIdentity = yield* bounded(
				() => options.resolveIdentity(intent.contactId),
				refusal('identity-unavailable'),
			)
			const identity = identitySchema.safeParse(rawIdentity)
			if (!identity.success || identity.data.contactId !== intent.contactId) {
				return yield* Effect.fail(refusal('subscriber-contact-mismatch'))
			}
			return {
				sequenceId: binding.sequenceId,
				subscriberId: identity.data.subscriberId,
				apiKey,
			}
		})

	const currentTime = () =>
		Effect.try({
			try: () => options.now(),
			catch: () => refusal('clock-unavailable'),
		}).pipe(
			Effect.flatMap((value) => {
				const parsed = parseIsoInstant(value)
				return parsed.ok
					? Effect.succeed(parsed.value)
					: Effect.fail(refusal('invalid-clock'))
			}),
		)

	return {
		apply: (intent) =>
			Effect.gen(function* () {
				const prepared = yield* prepare(intent)
				const startedAt = yield* currentTime()
				const from = parseIsoInstant(intent.notBefore)
				const until = parseIsoInstant(intent.notAfter)
				if (
					!from.ok ||
					!until.ok ||
					Date.parse(startedAt) < Date.parse(from.value) ||
					Date.parse(startedAt) > Date.parse(until.value)
				) {
					return yield* Effect.fail(refusal('outside-message-window'))
				}
				const url = `https://api.kit.com/v4/sequences/${prepared.sequenceId}/subscribers/${prepared.subscriberId}`
				const result = yield* bounded(async (signal) => {
					const response = await options.fetch(url, {
						method: 'POST',
						redirect: 'error',
						signal,
						headers: {
							'X-Kit-Api-Key': prepared.apiKey,
							'content-type': 'application/json',
						},
						body: '{}',
					})
					// Kit does not echo sequence_id; bind it to this exact endpoint, never a redirect.
					if (response.redirected || (response.url && response.url !== url))
						return { type: 'Mismatch' } as const
					if (response.status !== 200 && response.status !== 201)
						return { type: 'HttpFailure', status: response.status } as const
					const body: unknown = await response.json()
					const decoded = enrollmentSchema.safeParse(body)
					if (
						!decoded.success ||
						decoded.data.subscriber.id !== prepared.subscriberId ||
						decoded.data.subscriber.state !== 'active' ||
						(decoded.data.sequence_id !== undefined &&
							decoded.data.sequence_id !== prepared.sequenceId)
					)
						return { type: 'Mismatch' } as const
					return { type: 'Accepted', status: response.status } as const
				}, ambiguous('kit-enrollment-transport-or-body-unresolved'))
				if (result.type === 'Mismatch')
					return yield* Effect.fail(
						ambiguous('kit-enrollment-response-mismatch'),
					)
				if (result.type === 'HttpFailure') {
					// No auto retry, including 429: retain uncertainty until read-only reconciliation.
					return yield* Effect.fail(
						[401, 403, 404, 422].includes(result.status)
							? refusal(`kit-enrollment-http-${result.status}`)
							: ambiguous(`kit-enrollment-http-${result.status}`),
					)
				}
				const appliedAt = yield* currentTime().pipe(
					Effect.mapError(() => ambiguous('kit-accepted-clock-unavailable')),
				)
				return {
					appliedAt,
					providerReceiptId: `kit:sequence:${prepared.sequenceId}:subscriber:${prepared.subscriberId}:${result.status === 200 ? 'already-member' : 'added'}`,
				}
			}),
		reconcile: (intent, maxPages = 3) =>
			Effect.gen(function* () {
				if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10)
					return { type: 'Unknown', reason: 'invalid-page-cap' } as const
				const prepared = yield* prepare(intent)
				let cursor: string | undefined
				const seen = new Set<string>()
				for (let page = 0; page < maxPages; page++) {
					const query = new URLSearchParams({ status: 'all', per_page: '100' })
					if (cursor !== undefined) query.set('after', cursor)
					const url = `https://api.kit.com/v4/sequences/${prepared.sequenceId}/subscribers?${query}`
					const raw = yield* bounded(async (signal) => {
						const response = await options.fetch(url, {
							method: 'GET',
							redirect: 'error',
							signal,
							headers: { 'X-Kit-Api-Key': prepared.apiKey },
						})
						if (
							response.status !== 200 ||
							response.redirected ||
							(response.url && response.url !== url)
						)
							throw new Error('membership-unavailable')
						const body: unknown = await response.json()
						return body
					}, ambiguous('membership-unavailable'))
					const decoded = pageSchema.safeParse(raw)
					if (!decoded.success)
						return {
							type: 'Unknown',
							reason: 'invalid-membership-page',
						} as const
					if (
						decoded.data.subscribers.some(
							(subscriber) => subscriber.id === prepared.subscriberId,
						)
					)
						return {
							type: 'Present',
							meaning: 'sequence-membership-only',
						} as const
					if (!decoded.data.pagination.has_next_page)
						return {
							type: 'Absent',
							meaning: 'complete-read-not-resend-permission',
						} as const
					cursor = decoded.data.pagination.end_cursor
					if (!cursor || seen.has(cursor))
						return {
							type: 'Unknown',
							reason: 'invalid-membership-cursor',
						} as const
					seen.add(cursor)
				}
				return { type: 'Unknown', reason: 'membership-page-cap' } as const
			}).pipe(
				Effect.catchAll(() =>
					Effect.succeed({
						type: 'Unknown',
						reason: 'membership-unavailable',
					} as const),
				),
			),
	}
}
