import { env } from '@/env.mjs'
import { log } from '@/server/logger'

import { parseIanaTimeZone } from './evergreen-offer-journey/primitives'
import type { ContactEventRecord, SideEffectIntent } from './types'
import { valuePathIntentCompletedAt } from './value-path-completion'
import { SHADOW_NEWSLETTER_JOURNEY_ID } from './drovr-shadow-newsletter'

export const DROVR_SHADOW_TENANT_ID = 'org-aihero-shadow' as const
export const DROVR_SKILLS_COURSE_JOURNEY_ID =
	'value-path-skills-course' as const
export const DROVR_EVERGREEN_OFFER_JOURNEY_ID =
	'crash-course-evergreen-offer' as const
export const DROVR_SHADOW_NEWSLETTER_JOURNEY_ID =
	SHADOW_NEWSLETTER_JOURNEY_ID
export const DROVR_FALLBACK_TIMEZONE = 'America/Los_Angeles' as const

/** Tenants ai-hero speaks to: the shadow, and the authority once cut over. */
export const DROVR_AUTHORITY_TENANT_ID = 'org-aihero' as const
export type DrovrTenantId =
	| typeof DROVR_SHADOW_TENANT_ID
	| typeof DROVR_AUTHORITY_TENANT_ID
export type DrovrJourneyId =
	| typeof DROVR_SKILLS_COURSE_JOURNEY_ID
	| typeof DROVR_EVERGREEN_OFFER_JOURNEY_ID
	| typeof DROVR_SHADOW_NEWSLETTER_JOURNEY_ID

export type DrovrShadowEvent = {
	tenantId: DrovrTenantId
	contactId: string
	journeyId: DrovrJourneyId
	type:
		| 'contact.created'
		| 'value-path.answer-selected'
		| 'coupon.issued'
		| 'shadow.entered'
		| 'list.subscribed'
		| 'email.completed'
		| 'course.sequence-exhausted'
		| 'contact.unsubscribed'
		| 'purchase.recorded'
	occurredAt: string
	idempotencyKey: string
	payload?:
		| { emailResourceId: string }
		| { messageId: string }
		| { couponId: string; expiresAt: string }
		| { list: string }
		| { productId: string }
		| {
				valuePathSlug: string
				completedAt: string
				timezone: string
				timezoneSource: 'vercel-header' | 'fallback'
		  }
}

export type DrovrShadowFact =
	| {
			kind: 'contact-event'
			event: ContactEventRecord
	  }
	| {
			kind: 'side-effect-intent-completed'
			intent: SideEffectIntent
	  }
	| {
			kind: 'course-completed'
			contactId: string
			valuePathSlug: string
			/** Historic course completion, retained in the exhaustion payload. */
			completedAt: string
			timezoneHeader?: string
			/**
			 * A paced backfill is born now, not at the historic completion.
			 * Constraining both overrides to this shape keeps the forward fact unchanged.
			 */
			backfill?: {
				occurredAt: string
				idempotencyKey: string
			}
	  }

type DrovrShadowEmitterConfig = {
	ingestUrl?: string
	/** Bearer key for the shadow tenant. */
	apiKey?: string
	/** Bearer key for the authority tenant, once cut over. */
	authorityApiKey?: string
}

/**
 * One bearer key per drovr tenant. Every path that posts to drovr (the
 * durable delivery function, the direct fallback) must choose by tenant;
 * an authority completion sent with the shadow key is a 403 at drovr.
 */
export function drovrApiKeyForTenant(
	tenantId: string,
	config: Pick<DrovrShadowEmitterConfig, 'apiKey' | 'authorityApiKey'> = {
		apiKey: env.DROVR_SHADOW_API_KEY,
		authorityApiKey: env.DROVR_API_KEY_ORG_AIHERO,
	},
): string | undefined {
	switch (tenantId) {
		case DROVR_SHADOW_TENANT_ID:
			return config.apiKey
		case DROVR_AUTHORITY_TENANT_ID:
			return config.authorityApiKey
		default:
			return undefined
	}
}

type DrovrShadowEmitterOptions = {
	config?: DrovrShadowEmitterConfig
	fetch?: typeof fetch
	warn?: typeof log.warn
	timeoutMs?: number
}

export function mapDrovrShadowFact(fact: DrovrShadowFact): DrovrShadowEvent[] {
	if (fact.kind === 'contact-event') {
		return mapContactEvent(fact.event)
	}
	if (fact.kind === 'side-effect-intent-completed') {
		return mapCompletedIntent(fact.intent)
	}
	return mapCourseCompleted(fact)
}

export async function emitDrovrShadowFact(
	fact: DrovrShadowFact,
	options: DrovrShadowEmitterOptions = {},
): Promise<void> {
	await emitDrovrShadowEvents(mapDrovrShadowFact(fact), options)
}

/** Post already-mapped events directly, each with its tenant's key. */
export async function emitDrovrShadowEvents(
	events: readonly DrovrShadowEvent[],
	options: DrovrShadowEmitterOptions = {},
): Promise<void> {
	const config = options.config ?? {
		ingestUrl: env.DROVR_SHADOW_INGEST_URL,
		apiKey: env.DROVR_SHADOW_API_KEY,
		authorityApiKey: env.DROVR_API_KEY_ORG_AIHERO,
	}
	const ingestUrl = config.ingestUrl
	if (!ingestUrl) return
	if (events.length === 0) return

	const fetcher = options.fetch ?? fetch
	const warn = options.warn ?? log.warn
	try {
		await Promise.all(
			events.map(async (event) => {
				const apiKey = drovrApiKeyForTenant(event.tenantId, config)
				if (!apiKey) {
					await warnWithoutThrow(warn, 'drovr.shadow.tenant_key_missing', {
						tenantId: event.tenantId,
						idempotencyKey: event.idempotencyKey,
					})
					return
				}
				await postDrovrShadowEvent({
					event,
					config: { ingestUrl, apiKey },
					fetcher,
					warn,
					timeoutMs: options.timeoutMs ?? 3000,
				})
			}),
		)
	} catch (error) {
		await warnWithoutThrow(warn, 'drovr.shadow.emit_failed', {
			eventCount: events.length,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export function emitDrovrShadowFactSafely(fact: DrovrShadowFact): void {
	try {
		void emitDrovrShadowFact(fact).catch(() => undefined)
	} catch {
		// Shadow telemetry must never escape into the authoritative host flow.
	}
}

function mapContactEvent(event: ContactEventRecord): DrovrShadowEvent[] {
	const base = {
		tenantId: DROVR_SHADOW_TENANT_ID,
		contactId: event.contactId,
		occurredAt: event.occurredAt,
		idempotencyKey: contactEventIdempotencyKey(event),
	}

	switch (event.eventType) {
		case 'skills-newsletter.subscribed':
			return [
				{
					...base,
					journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
					type: 'contact.created',
				},
			]
		// Ownership assigned to drovr is the named journey's birth in the
		// authority tenant. The discriminator prevents an evergreen finisher
		// assignment from birthing a phantom skills-course actor.
		case 'journey.owner.assigned': {
			const journeyId = ownerAssignmentJourneyId(event.providerEventId)
			if (!journeyId) return []
			return [
				{
					...base,
					tenantId: DROVR_AUTHORITY_TENANT_ID,
					journeyId,
					type: 'contact.created',
				},
			]
		}
		case 'value-path.answer-selected': {
			const emailResourceId = emailResourceIdFromKeywords(
				event.payloadSummary.keywords,
			)
			if (!emailResourceId) return []
			return [
				{
					...base,
					journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
					type: 'value-path.answer-selected',
					payload: { emailResourceId },
				},
			]
		}
		case 'contact.unsubscribed':
			return bothJourneys(base, 'contact.unsubscribed')
		case 'purchase.recorded': {
			const productId = purchaseProductId(event.payloadSummary.keywords)
			if (!productId) return []
			return bothJourneys(base, 'purchase.recorded', { productId })
		}
		default:
			return []
	}
}

function mapCompletedIntent(intent: SideEffectIntent): DrovrShadowEvent[] {
	if (intent.provider !== 'kit' || intent.status !== 'completed') return []
	// Sequence sends complete to their owning actor only: the shadow's
	// actors run their own log executor and never hear from us.
	if (intent.type === 'send-shadow-newsletter-email') {
		const completion = drovrShadowNewsletterCompletion(intent)
		return completion ? [completion] : []
	}
	if (
		intent.type === 'send-evergreen-email' ||
		intent.type === 'issue-evergreen-coupon' ||
		intent.type === 'subscribe-evergreen-list'
	) {
		const completion = drovrEvergreenCompletion(intent)
		return completion ? [completion] : []
	}
	if (intent.type !== 'send-value-path-email') return []
	const completedAt = valuePathIntentCompletedAt(intent)
	const sourceEmailResourceId = stringValue(intent.metadata.emailResourceId)
	const emailResourceId = sourceEmailResourceId
		? canonicalSkillsEmailResourceId(sourceEmailResourceId)
		: undefined
	if (!completedAt || !sourceEmailResourceId || !emailResourceId) return []

	const shadowCompletion: DrovrShadowEvent = {
		tenantId: DROVR_SHADOW_TENANT_ID,
		contactId: intent.contactId,
		journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
		type: 'email.completed',
		occurredAt: completedAt,
		idempotencyKey: `aihero:intent-completed:${intent.id}`,
		payload: { emailResourceId },
	}
	// An intent drovr planned completes back to the tenant that owns it,
	// keyed the way drovr's own executors key completions. The shadow hears
	// it too, so the shadow actor of an owned contact keeps mirroring
	// instead of sitting at pending and tripping the pending-intent alert.
	const ownerCompletion = drovrOwnedCompletion(intent)
	return ownerCompletion
		? [ownerCompletion, shadowCompletion]
		: [shadowCompletion]
}

function drovrShadowNewsletterCompletion(
	intent: SideEffectIntent,
): DrovrShadowEvent | undefined {
	const owner = intent.metadata.drovr
	if (!owner || typeof owner !== 'object') return undefined
	const record = owner as Record<string, unknown>
	const tenantId = stringValue(record.tenantId)
	const journeyId = stringValue(record.journeyId)
	const intentKey = stringValue(record.intentKey)
	const catalogRevision = stringValue(intent.metadata.catalogRevision)
	const messageId = stringValue(intent.metadata.messageId)
	const completedAt =
		stringValue(intent.completedAt) ?? stringValue(intent.metadata.completedAt)
	if (
		!intentKey ||
		!completedAt ||
		!messageId ||
		!catalogRevision ||
		(tenantId !== DROVR_SHADOW_TENANT_ID &&
			tenantId !== DROVR_AUTHORITY_TENANT_ID) ||
		journeyId !== DROVR_SHADOW_NEWSLETTER_JOURNEY_ID
	) {
		return undefined
	}
	return {
		tenantId,
		contactId: intent.contactId,
		journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		type: 'email.completed',
		occurredAt: completedAt,
		idempotencyKey: `completion:${intentKey}`,
		payload: { messageId },
	}
}

function drovrEvergreenCompletion(
	intent: SideEffectIntent,
): DrovrShadowEvent | undefined {
	const owner = intent.metadata.drovr
	if (!owner || typeof owner !== 'object') return undefined
	const record = owner as Record<string, unknown>
	const tenantId = stringValue(record.tenantId)
	const intentKey = stringValue(record.intentKey)
	const completedAt =
		stringValue(intent.completedAt) ?? stringValue(intent.metadata.completedAt)
	if (
		!intentKey ||
		!completedAt ||
		(tenantId !== DROVR_SHADOW_TENANT_ID &&
			tenantId !== DROVR_AUTHORITY_TENANT_ID) ||
		stringValue(record.journeyId) !== DROVR_EVERGREEN_OFFER_JOURNEY_ID
	) {
		return undefined
	}
	const base = {
		tenantId,
		contactId: intent.contactId,
		journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
		occurredAt: completedAt,
		idempotencyKey: `completion:${intentKey}`,
	}
	if (intent.type === 'issue-evergreen-coupon') {
		const couponId = stringValue(intent.metadata.couponId)
		const expiresAt = stringValue(intent.metadata.expiresAt)
		if (!couponId || !expiresAt) return undefined
		return {
			...base,
			type: 'coupon.issued',
			payload: { couponId, expiresAt },
		}
	}
	if (intent.type === 'subscribe-evergreen-list') {
		const list = stringValue(intent.metadata.list)
		if (!list) return undefined
		// The shadow-newsletter handoff closes the journey; any other list
		// completes generically, mirroring drovr's own log executor.
		return {
			...base,
			type: list === 'shadow-newsletter' ? 'shadow.entered' : 'list.subscribed',
			payload: { list },
		}
	}
	const messageId = stringValue(intent.metadata.messageId)
	if (!messageId) return undefined
	return { ...base, type: 'email.completed', payload: { messageId } }
}

function drovrOwnedCompletion(
	intent: SideEffectIntent,
): DrovrShadowEvent | undefined {
	const owner = intent.metadata.drovr
	if (!owner || typeof owner !== 'object') return undefined
	const record = owner as Record<string, unknown>
	const tenantId = stringValue(record.tenantId)
	const journeyId = stringValue(record.journeyId)
	const intentKey = stringValue(record.intentKey)
	const completedAt = valuePathIntentCompletedAt(intent)
	const sourceEmailResourceId = stringValue(intent.metadata.emailResourceId)
	const emailResourceId = sourceEmailResourceId
		? canonicalSkillsEmailResourceId(sourceEmailResourceId)
		: undefined
	if (
		!tenantId ||
		!journeyId ||
		!intentKey ||
		!completedAt ||
		!emailResourceId ||
		(tenantId !== DROVR_SHADOW_TENANT_ID &&
			tenantId !== DROVR_AUTHORITY_TENANT_ID) ||
		(journeyId !== DROVR_SKILLS_COURSE_JOURNEY_ID &&
			journeyId !== DROVR_EVERGREEN_OFFER_JOURNEY_ID)
	) {
		return undefined
	}
	return {
		tenantId,
		contactId: intent.contactId,
		journeyId,
		type: 'email.completed',
		occurredAt: completedAt,
		idempotencyKey: `completion:${intentKey}`,
		payload: { emailResourceId },
	}
}

function mapCourseCompleted(
	fact: Extract<DrovrShadowFact, { kind: 'course-completed' }>,
): DrovrShadowEvent[] {
	const timezone = courseCompletionTimezone(fact.timezoneHeader)
	const evergreenPayload = {
		valuePathSlug: fact.valuePathSlug,
		completedAt: fact.completedAt,
		timezone: timezone.value,
		timezoneSource: timezone.source,
	}
	if (fact.backfill) {
		return [
			{
				tenantId: DROVR_AUTHORITY_TENANT_ID,
				contactId: fact.contactId,
				journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
				type: 'course.sequence-exhausted',
				occurredAt: fact.backfill.occurredAt,
				idempotencyKey: fact.backfill.idempotencyKey,
				payload: evergreenPayload,
			},
		]
	}
	const completionBase = {
		tenantId: DROVR_SHADOW_TENANT_ID,
		contactId: fact.contactId,
		type: 'course.sequence-exhausted' as const,
		occurredAt: fact.completedAt,
		idempotencyKey: `aihero:completion:${fact.contactId}:${fact.valuePathSlug}`,
	}
	return [
		{
			...completionBase,
			journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
		},
		{
			...completionBase,
			journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			payload: evergreenPayload,
		},
	]
}

function bothJourneys(
	base: Pick<
		DrovrShadowEvent,
		'tenantId' | 'contactId' | 'occurredAt' | 'idempotencyKey'
	>,
	type: 'contact.unsubscribed' | 'purchase.recorded',
	payload?: { productId: string },
): DrovrShadowEvent[] {
	return [DROVR_SKILLS_COURSE_JOURNEY_ID, DROVR_EVERGREEN_OFFER_JOURNEY_ID].map(
		(journeyId) => ({
			...base,
			journeyId,
			type,
			...(payload ? { payload } : {}),
		}),
	)
}

function ownerAssignmentJourneyId(
	providerEventId: string,
): DrovrJourneyId | undefined {
	if (providerEventId.endsWith(`:${DROVR_SKILLS_COURSE_JOURNEY_ID}`)) {
		return DROVR_SKILLS_COURSE_JOURNEY_ID
	}
	if (providerEventId.endsWith(`:${DROVR_EVERGREEN_OFFER_JOURNEY_ID}`)) {
		return DROVR_EVERGREEN_OFFER_JOURNEY_ID
	}
	return undefined
}

function contactEventIdempotencyKey(event: ContactEventRecord) {
	const sourceKey = event.semanticIdempotencyKey.trim()
	if (sourceKey.length > 0 && !containsEmailAddress(sourceKey)) {
		return `aihero:${sourceKey}`
	}
	return `aihero:contact-event:${event.id}`
}

function containsEmailAddress(value: string) {
	return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)
}

function emailResourceIdFromKeywords(keywords: string[]) {
	for (const keyword of keywords) {
		const resourceId = canonicalSkillsEmailResourceId(keyword)
		if (resourceId) return resourceId
	}
	return undefined
}

function canonicalSkillsEmailResourceId(value: string) {
	const match = value.match(/(?:team-)?email-(\d+)$/)
	if (!match) return undefined
	const position = Number(match[1])
	if (!Number.isSafeInteger(position) || position < 0) return undefined
	return `ai-hero-skills-workflow.email-${position}`
}

function purchaseProductId(keywords: string[]) {
	const markerIndex = keywords.indexOf('purchase-recorded')
	if (markerIndex < 0) return undefined
	const value = keywords[markerIndex + 1]
	return value && !value.startsWith('status-') ? value : undefined
}

function courseCompletionTimezone(headerValue?: string) {
	const parsed = headerValue ? parseIanaTimeZone(headerValue) : undefined
	return parsed?.ok
		? { value: parsed.value, source: 'vercel-header' as const }
		: { value: DROVR_FALLBACK_TIMEZONE, source: 'fallback' as const }
}

async function postDrovrShadowEvent(args: {
	event: DrovrShadowEvent
	config: DrovrDeliveryConfig
	fetcher: typeof fetch
	warn: typeof log.warn
	timeoutMs: number
}) {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs)
	try {
		const response = await args.fetcher(args.config.ingestUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${args.config.apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(args.event),
			signal: controller.signal,
		})
		if (response.status === 200 || response.status === 202) {
			await response.json()
			return
		}

		if (response.status >= 400 && response.status < 500) {
			await warnWithoutThrow(args.warn, 'drovr.shadow.rejected', {
				status: response.status,
				journeyId: args.event.journeyId,
				type: args.event.type,
				idempotencyKey: args.event.idempotencyKey,
				problem: await boundedResponseBody(response),
			})
			return
		}

		await warnWithoutThrow(args.warn, 'drovr.shadow.unaccepted_response', {
			status: response.status,
			journeyId: args.event.journeyId,
			type: args.event.type,
			idempotencyKey: args.event.idempotencyKey,
		})
	} finally {
		clearTimeout(timeout)
	}
}

async function boundedResponseBody(response: Response) {
	const text = (await response.text()).slice(0, 4096)
	if (text.length === 0) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return text
	}
}

async function warnWithoutThrow(
	warn: typeof log.warn,
	event: string,
	data: Record<string, unknown>,
) {
	try {
		await warn(event, data)
	} catch {
		// Logging cannot make shadow delivery authoritative.
	}
}

function stringValue(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * What one delivery attempt concluded. `accepted` is drovr's 200/202;
 * `rejected` is a 4xx problem detail, final by contract (replaying the
 * same idempotency key cannot change the answer); `failed` is anything
 * transient (5xx, network, timeout) and is the only outcome worth a retry.
 */
export type DrovrDeliveryOutcome =
	| { status: 'accepted' }
	| { status: 'rejected'; httpStatus: number; problem: unknown }
	| { status: 'failed'; reason: string; httpStatus?: number }

export type DrovrDeliveryConfig = { ingestUrl: string; apiKey: string }

/**
 * Post one event and report the outcome instead of swallowing it. The
 * durable delivery function builds its retry decision on this; the legacy
 * fire-and-forget path above keeps its own warnings.
 */
export async function deliverDrovrShadowEvent(args: {
	event: DrovrShadowEvent
	config: DrovrDeliveryConfig
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<DrovrDeliveryOutcome> {
	const fetcher = args.fetcher ?? fetch
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000)
	try {
		const response = await fetcher(args.config.ingestUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${args.config.apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(args.event),
			signal: controller.signal,
		})
		if (response.status === 200 || response.status === 202) {
			// Accepted is decided by the status alone. The body is never read,
			// so an oversized or stalled body cannot turn an accepted event
			// into a retried one.
			return { status: 'accepted' }
		}
		if (response.status >= 400 && response.status < 500) {
			return {
				status: 'rejected',
				httpStatus: response.status,
				problem: await boundedProblemBody(response),
			}
		}
		return {
			status: 'failed',
			httpStatus: response.status,
			reason: `drovr answered ${response.status}`,
		}
	} catch (error) {
		return {
			status: 'failed',
			reason: error instanceof Error ? error.message : String(error),
		}
	} finally {
		clearTimeout(timeout)
	}
}

const PROBLEM_BODY_LIMIT_BYTES = 4096

/**
 * Read at most 4 KiB of a problem body and stop. A 4xx is conclusive by
 * status; the body is only evidence for the log, so a huge or stalled
 * body must never turn a final rejection into a retryable failure. Read
 * errors and aborts yield null instead of throwing.
 */
async function boundedProblemBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) return null
	const chunks: Uint8Array[] = []
	let received = 0
	try {
		while (received < PROBLEM_BODY_LIMIT_BYTES) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			const room = PROBLEM_BODY_LIMIT_BYTES - received
			const slice = value.byteLength > room ? value.subarray(0, room) : value
			chunks.push(slice)
			received += slice.byteLength
		}
	} catch {
		// Partial evidence is still evidence; the status already decided.
	} finally {
		try {
			await reader.cancel()
		} catch {
			// The response is finished either way.
		}
	}
	if (received === 0) return null
	const joined = new Uint8Array(received)
	let offset = 0
	for (const chunk of chunks) {
		joined.set(chunk, offset)
		offset += chunk.byteLength
	}
	const text = new TextDecoder().decode(joined)
	try {
		return JSON.parse(text) as unknown
	} catch {
		return text
	}
}
