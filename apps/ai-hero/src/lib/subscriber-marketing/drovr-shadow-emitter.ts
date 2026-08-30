import { env } from '@/env.mjs'
import { log } from '@/server/logger'

import { parseIanaTimeZone } from './evergreen-offer-journey/primitives'
import type { ContactEventRecord, SideEffectIntent } from './types'
import { valuePathIntentCompletedAt } from './value-path-completion'

export const DROVR_SHADOW_TENANT_ID = 'org-aihero-shadow' as const
export const DROVR_SKILLS_COURSE_JOURNEY_ID =
	'value-path-skills-course' as const
export const DROVR_EVERGREEN_OFFER_JOURNEY_ID =
	'crash-course-evergreen-offer' as const
export const DROVR_FALLBACK_TIMEZONE = 'America/Los_Angeles' as const

export type DrovrShadowEvent = {
	tenantId: typeof DROVR_SHADOW_TENANT_ID
	contactId: string
	journeyId:
		| typeof DROVR_SKILLS_COURSE_JOURNEY_ID
		| typeof DROVR_EVERGREEN_OFFER_JOURNEY_ID
	type:
		| 'contact.created'
		| 'value-path.answer-selected'
		| 'email.completed'
		| 'course.completed'
		| 'contact.unsubscribed'
		| 'purchase.recorded'
	occurredAt: string
	idempotencyKey: string
	payload?:
		| { emailResourceId: string }
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
			completedAt: string
			timezoneHeader?: string
	  }

type DrovrShadowEmitterConfig = {
	ingestUrl?: string
	apiKey?: string
}

type DrovrShadowEmitterOptions = {
	config?: DrovrShadowEmitterConfig
	fetch?: typeof fetch
	warn?: typeof log.warn
	timeoutMs?: number
}

export function mapDrovrShadowFact(
	fact: DrovrShadowFact,
): DrovrShadowEvent[] {
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
	const config = options.config ?? {
		ingestUrl: env.DROVR_SHADOW_INGEST_URL,
		apiKey: env.DROVR_SHADOW_API_KEY,
	}
	const ingestUrl = config.ingestUrl
	const apiKey = config.apiKey
	if (!ingestUrl || !apiKey) return

	const events = mapDrovrShadowFact(fact)
	if (events.length === 0) return

	const fetcher = options.fetch ?? fetch
	const warn = options.warn ?? log.warn
	try {
		await Promise.all(
			events.map((event) =>
				postDrovrShadowEvent({
					event,
					config: { ingestUrl, apiKey },
					fetcher,
					warn,
					timeoutMs: options.timeoutMs ?? 3000,
				}),
			),
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
	if (
		intent.provider !== 'kit' ||
		intent.type !== 'send-value-path-email' ||
		intent.status !== 'completed'
	) {
		return []
	}
	const completedAt = valuePathIntentCompletedAt(intent)
	const sourceEmailResourceId = stringValue(intent.metadata.emailResourceId)
	const emailResourceId = sourceEmailResourceId
		? canonicalSkillsEmailResourceId(sourceEmailResourceId)
		: undefined
	if (!completedAt || !sourceEmailResourceId || !emailResourceId) return []

	return [
		{
			tenantId: DROVR_SHADOW_TENANT_ID,
			contactId: intent.contactId,
			journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
			type: 'email.completed',
			occurredAt: completedAt,
			idempotencyKey: `aihero:intent-completed:${intent.id}`,
			payload: { emailResourceId },
		},
	]
}

function mapCourseCompleted(
	fact: Extract<DrovrShadowFact, { kind: 'course-completed' }>,
): DrovrShadowEvent[] {
	const timezone = courseCompletionTimezone(fact.timezoneHeader)
	const completionBase = {
		tenantId: DROVR_SHADOW_TENANT_ID,
		contactId: fact.contactId,
		type: 'course.completed' as const,
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
			payload: {
				valuePathSlug: fact.valuePathSlug,
				completedAt: fact.completedAt,
				timezone: timezone.value,
				timezoneSource: timezone.source,
			},
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
	config: Required<DrovrShadowEmitterConfig>
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
