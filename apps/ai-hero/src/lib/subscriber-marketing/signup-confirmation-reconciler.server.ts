import { db } from '@/db'
import {
	contact,
	contactEvent,
	providerIdentity,
	sideEffectIntent,
} from '@/db/schema'
import { AI_HERO_SKILLS_EXCLUSION_TAG_IDS } from '@/lib/kit-broadcasts'
import { UNSUBSCRIBE_KIT_LIST_INTENT_TYPE } from '@/lib/subscriber-marketing/drovr-list-unsubscribe'
import { JOURNEY_OWNER_ASSIGNED_EVENT_TYPE } from '@/lib/subscriber-marketing/drovr-ownership'
import { DROVR_SKILLS_COURSE_JOURNEY_ID } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	buildSignupConfirmationReconciliationPlan,
	buildSignupGapPreview,
	fetchKitSignupGapPageWithRetry,
	normalizeSignupGapEmail,
	type SignupConfirmationReconciliationPlan,
	type SignupGapKitSubscriber,
	type SignupGapKitSubscriberState,
} from '@/lib/subscriber-marketing/signup-gap-recovery'
import { SKILLS_WORKFLOW_VALUE_PATH } from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import { AIH_COURSE_COMPLETED_AT_FIELD } from '@/lib/subscriber-marketing/value-path-finisher-capture'
import { emailEquivalenceKey } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { SKILLS_WORKFLOW_EMAIL_STEPS } from '@/lib/subscriber-marketing/skills-workflow-path'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'

export const SKILLS_NEWSLETTER_FORM_ID = 9376133
/**
 * The floor: only subscribers who joined the form at or after this instant
 * are ever replayed. Kit has no confirmation time, so a signup from before
 * it that confirms later is not either. Joel's call (2026-09-25): the
 * backlog stranded before this fix is let go, not enrolled.
 */
export const SKILLS_CONFIRMATION_RECONCILIATION_START =
	'2026-09-25T00:00:00.000Z'
/**
 * Every replayed confirmation of a new signup is a birth in drovr, so the
 * hourly run stays small and a backlog drains over a few runs.
 */
export const SKILLS_CONFIRMATION_RECONCILIATION_LIMIT = 50

/**
 * The stop lever: AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT can pause
 * (0) or slow the reconciler, never raise it past the default. Anything
 * unparseable falls back to the default.
 */
export function skillsConfirmationReconciliationLimit(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const raw = env.AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT?.trim()
	if (!raw || !/^\d+$/.test(raw))
		return SKILLS_CONFIRMATION_RECONCILIATION_LIMIT
	return Math.min(Number(raw), SKILLS_CONFIRMATION_RECONCILIATION_LIMIT)
}

/** Opt-out evidence recorded locally: Kit webhooks and drovr list unsubscribes. */
const OPT_OUT_EVENT_TYPES: string[] = [
	'contact.unsubscribed',
	'contact.bounced',
	'contact.complained',
]

/** A legacy or drovr send of any course email; each ran through the executor. */
const SEND_VALUE_PATH_EMAIL_INTENT_TYPE = 'send-value-path-email'

/**
 * Email 0 of the individual and team skills paths. Every course send is a
 * per-email Kit sequence subscription and email 0 comes first, so anyone
 * who got any course email is in one of these.
 */
export const SKILLS_EMAIL_ZERO_KIT_SEQUENCE_IDS =
	SKILLS_WORKFLOW_EMAIL_STEPS.filter((step) =>
		step.emailResourceId.endsWith('-0'),
	).map((step) => step.kitSequenceId)

/** Kit lists evidence 1000 to a page; this bounds a run at 100k ids a list. */
const KIT_EVIDENCE_PAGE_CAP = 100

const KIT_SUBSCRIBER_STATES = [
	'active',
	'inactive',
	'cancelled',
	'bounced',
	'complained',
] as const satisfies readonly SignupGapKitSubscriberState[]

type KitFormSubscriberRecord = SignupGapKitSubscriber & {
	addedAt: string
}

type ReconcilerDatabase = Pick<typeof db, 'select'>

export async function buildSignupConfirmationReconciliationBatch(args?: {
	to?: string
	limit?: number
	database?: ReconcilerDatabase
}): Promise<SignupConfirmationReconciliationPlan> {
	const to = new Date(args?.to ?? new Date().toISOString()).toISOString()
	const subscribers = await fetchKitFormSubscribersForStates({
		formId: SKILLS_NEWSLETTER_FORM_ID,
		addedAfter: SKILLS_CONFIRMATION_RECONCILIATION_START,
		states: KIT_SUBSCRIBER_STATES,
	})
	const [identityMatches, taggedOptOuts, emailZeroMembers] = await Promise.all([
		fetchIdentityMatches(subscribers, args?.database ?? db),
		fetchKitSubscriberIdsFrom(
			AI_HERO_SKILLS_EXCLUSION_TAG_IDS.map((tagId) => `tags/${tagId}`),
		),
		fetchKitSubscriberIdsFrom(
			SKILLS_EMAIL_ZERO_KIT_SEQUENCE_IDS.map((id) => `sequences/${id}`),
		),
	])
	const courseCompleted = subscribers
		.filter((subscriber) => {
			const value = subscriber.fields?.[AIH_COURSE_COMPLETED_AT_FIELD]
			return value != null && String(value).trim() !== ''
		})
		.map((subscriber) => subscriber.kitSubscriberId)
	const preview = buildSignupGapPreview({
		subscribers,
		identityMatches: {
			...identityMatches,
			optedOutKitSubscriberIds: new Set([
				...identityMatches.optedOutKitSubscriberIds,
				...taggedOptOuts,
			]),
			courseHistoryKitSubscriberIds: new Set([
				...identityMatches.courseHistoryKitSubscriberIds,
				...emailZeroMembers,
				...courseCompleted,
			]),
		},
		formId: SKILLS_NEWSLETTER_FORM_ID,
		from: SKILLS_CONFIRMATION_RECONCILIATION_START,
		to,
		now: to,
	})
	return buildSignupConfirmationReconciliationPlan({
		preview,
		limit: args?.limit ?? skillsConfirmationReconciliationLimit(),
	})
}

async function fetchIdentityMatches(
	subscribers: SignupGapKitSubscriber[],
	database: ReconcilerDatabase,
) {
	const emails = Array.from(
		new Set(
			subscribers
				.map((subscriber) => normalizeSignupGapEmail(subscriber.email))
				.filter((email): email is string => Boolean(email)),
		),
	)
	const subscriberIds = Array.from(
		new Set(subscribers.map((subscriber) => subscriber.kitSubscriberId)),
	)
	const contactEmails = new Set<string>()
	const matchedSubscriberIds = new Set<string>()
	const courseEntryKitSubscriberIds = new Set<string>()
	const optedOutKitSubscriberIds = new Set<string>()
	const optedOutEmails = new Set<string>()
	const courseHistoryKitSubscriberIds = new Set<string>()
	const courseHistoryEmails = new Set<string>()

	// Address evidence goes through the canonical email key. A stale key
	// anywhere means an equivalent address could hide behind a raw spelling,
	// so the run fails instead of entering anyone on partial evidence.
	const [stale] = await database
		.select({ id: contact.id })
		.from(contact)
		.where(eq(contact.emailKeyStale, 1))
		.limit(1)
	if (stale) {
		throw new ReconcilerEvidenceUnavailableError(
			'contact-email-key',
			'a Contact email key is stale',
		)
	}
	const emailByKey = new Map(
		emails.map((email) => [emailEquivalenceKey(email), email]),
	)
	for (const keyChunk of chunk(Array.from(emailByKey.keys()), 500)) {
		const rows = await database
			.select({ emailKey: contact.emailKey })
			.from(contact)
			.where(inArray(contact.emailKey, keyChunk))
		for (const row of rows) {
			const email = row.emailKey ? emailByKey.get(row.emailKey) : undefined
			if (email) contactEmails.add(email)
		}
		// A contact Kit knows under another subscriber id still carries its
		// opt-out and its course history by address.
		const optOutEventRows = await database
			.select({ emailKey: contact.emailKey })
			.from(contact)
			.innerJoin(contactEvent, eq(contactEvent.contactId, contact.id))
			.where(
				and(
					inArray(contact.emailKey, keyChunk),
					inArray(contactEvent.eventType, OPT_OUT_EVENT_TYPES),
				),
			)
		const intentRows = await database
			.select({ emailKey: contact.emailKey, type: sideEffectIntent.type })
			.from(contact)
			.innerJoin(sideEffectIntent, eq(sideEffectIntent.contactId, contact.id))
			.where(
				and(
					inArray(contact.emailKey, keyChunk),
					inArray(sideEffectIntent.type, [
						UNSUBSCRIBE_KIT_LIST_INTENT_TYPE,
						SEND_VALUE_PATH_EMAIL_INTENT_TYPE,
					]),
				),
			)
		for (const row of optOutEventRows) {
			const email = row.emailKey ? emailByKey.get(row.emailKey) : undefined
			if (email) optedOutEmails.add(email)
		}
		for (const row of intentRows) {
			const email = row.emailKey ? emailByKey.get(row.emailKey) : undefined
			if (!email) continue
			if (row.type === UNSUBSCRIBE_KIT_LIST_INTENT_TYPE) {
				optedOutEmails.add(email)
			} else {
				courseHistoryEmails.add(email)
			}
		}
	}
	for (const idChunk of chunk(subscriberIds, 500)) {
		const identityRows = await database
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
				),
			)
		for (const row of identityRows) matchedSubscriberIds.add(row.externalId)

		// Entered means either planner started the course: the legacy entry
		// event, or the contact's own drovr ownership assignment for the skills
		// course (drovr-owned contacts never get a legacy entry event).
		const entryRows = await database
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.innerJoin(
				contactEvent,
				eq(contactEvent.contactId, providerIdentity.contactId),
			)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
					or(
						and(
							eq(contactEvent.eventType, 'value-path.entered'),
							eq(
								contactEvent.providerReference,
								`value-path:${SKILLS_WORKFLOW_VALUE_PATH}`,
							),
						),
						and(
							eq(contactEvent.eventType, JOURNEY_OWNER_ASSIGNED_EVENT_TYPE),
							eq(
								contactEvent.providerEventId,
								sql`concat('drovr-owner:', ${providerIdentity.contactId}, ${`:${DROVR_SKILLS_COURSE_JOURNEY_ID}`})`,
							),
						),
					),
				),
			)
		for (const row of entryRows) {
			courseEntryKitSubscriberIds.add(row.externalId)
		}

		const optOutEventRows = await database
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.innerJoin(
				contactEvent,
				eq(contactEvent.contactId, providerIdentity.contactId),
			)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
					inArray(contactEvent.eventType, OPT_OUT_EVENT_TYPES),
				),
			)
		const intentRows = await database
			.select({
				externalId: providerIdentity.externalId,
				type: sideEffectIntent.type,
			})
			.from(providerIdentity)
			.innerJoin(
				sideEffectIntent,
				eq(sideEffectIntent.contactId, providerIdentity.contactId),
			)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
					inArray(sideEffectIntent.type, [
						UNSUBSCRIBE_KIT_LIST_INTENT_TYPE,
						SEND_VALUE_PATH_EMAIL_INTENT_TYPE,
					]),
				),
			)
		for (const row of optOutEventRows) {
			optedOutKitSubscriberIds.add(row.externalId)
		}
		for (const row of intentRows) {
			if (row.type === UNSUBSCRIBE_KIT_LIST_INTENT_TYPE) {
				optedOutKitSubscriberIds.add(row.externalId)
			} else {
				courseHistoryKitSubscriberIds.add(row.externalId)
			}
		}
	}

	return {
		contactEmails,
		kitSubscriberIds: matchedSubscriberIds,
		courseEntryKitSubscriberIds,
		optedOutKitSubscriberIds,
		optedOutEmails,
		courseHistoryKitSubscriberIds,
		courseHistoryEmails,
	}
}

/**
 * Consent or course-history evidence that could not be read completely.
 * The run fails rather than enter anyone on partial evidence; the Inngest
 * function's retries own the retry (the page fetch retries only 5xx).
 */
export class ReconcilerEvidenceUnavailableError extends Error {
	readonly source: string
	readonly reason: string

	constructor(source: string, reason: string) {
		super(
			`Confirmation reconciliation evidence unavailable: ${source}: ${reason}`,
		)
		this.name = 'ReconcilerEvidenceUnavailableError'
		this.source = source
		this.reason = reason
	}
}

const KitSubscriberIdPage = z.object({
	subscribers: z.array(
		z.object({
			id: z.union([
				z.number().int().positive(),
				z.string().regex(/^[1-9]\d*$/),
			]),
		}),
	),
	pagination: z.object({
		has_next_page: z.boolean(),
		end_cursor: z.string().min(1).nullable().optional(),
	}),
})

/**
 * Every subscriber id (any state) listed under these Kit resources, e.g.
 * `tags/8244351` or `sequences/2757199`. Parsed strictly at the boundary:
 * an HTTP failure, a malformed page or a next page without a cursor
 * throws, never yields a shorter list.
 */
async function fetchKitSubscriberIdsFrom(resources: readonly string[]) {
	const apiKey = kitApiKey()
	const ids = new Set<string>()
	for (const resource of resources) {
		let cursor: string | undefined
		for (let page = 0; ; page++) {
			if (page >= KIT_EVIDENCE_PAGE_CAP) {
				throw new ReconcilerEvidenceUnavailableError(
					resource,
					`more than ${KIT_EVIDENCE_PAGE_CAP} pages`,
				)
			}
			const url = new URL(
				`https://api.convertkit.com/v4/${resource}/subscribers`,
			)
			url.searchParams.set('status', 'all')
			url.searchParams.set('per_page', '1000')
			if (cursor) url.searchParams.set('after', cursor)
			const response = await fetchKitSignupGapPageWithRetry({
				request: () => fetch(url, { headers: { 'X-Kit-Api-Key': apiKey } }),
			})
			if (!response.ok) {
				throw new ReconcilerEvidenceUnavailableError(
					resource,
					`HTTP ${response.status}`,
				)
			}
			const parsed = KitSubscriberIdPage.safeParse(
				await response.json().catch(() => undefined),
			)
			if (!parsed.success) {
				throw new ReconcilerEvidenceUnavailableError(resource, 'malformed page')
			}
			for (const subscriber of parsed.data.subscribers) {
				ids.add(String(subscriber.id))
			}
			if (!parsed.data.pagination.has_next_page) break
			cursor = parsed.data.pagination.end_cursor ?? undefined
			if (!cursor) {
				throw new ReconcilerEvidenceUnavailableError(
					resource,
					'next page without a cursor',
				)
			}
		}
	}
	return ids
}

function kitApiKey() {
	const apiKey =
		process.env.CONVERTKIT_V4_API_KEY ?? process.env.CONVERTKIT_API_KEY
	if (!apiKey) {
		throw new Error(
			'Confirmation reconciliation requires CONVERTKIT_V4_API_KEY or CONVERTKIT_API_KEY',
		)
	}
	return apiKey
}

async function fetchKitFormSubscribersForStates(args: {
	formId: number
	addedAfter: string
	states: readonly SignupGapKitSubscriberState[]
}) {
	const records: KitFormSubscriberRecord[] = []
	for (const state of args.states) {
		records.push(
			...(await fetchKitFormSubscribers({
				formId: args.formId,
				addedAfter: args.addedAfter,
				state,
			})),
		)
	}
	return Array.from(
		new Map(records.map((record) => [record.kitSubscriberId, record])).values(),
	)
}

async function fetchKitFormSubscribers(args: {
	formId: number
	addedAfter: string
	state: SignupGapKitSubscriberState
}) {
	const apiKey = kitApiKey()
	const subscribers: KitFormSubscriberRecord[] = []
	let cursor: string | undefined
	for (let page = 0; page < 100; page++) {
		const url = new URL(
			`https://api.convertkit.com/v4/forms/${args.formId}/subscribers`,
		)
		url.searchParams.set('status', args.state)
		url.searchParams.set('per_page', '1000')
		url.searchParams.set(
			'added_after',
			new Date(args.addedAfter).toISOString().slice(0, 10),
		)
		if (cursor) url.searchParams.set('after', cursor)
		const response = await fetchKitSignupGapPageWithRetry({
			request: () =>
				fetch(url, {
					headers: { 'X-Kit-Api-Key': apiKey },
				}),
		})
		const payload = (await response.json()) as Record<string, unknown>
		if (!response.ok) {
			throw new Error(
				`Kit confirmation reconciliation failed with HTTP ${response.status}`,
			)
		}
		subscribers.push(...parseKitFormSubscribers(payload))
		const pagination = asRecord(payload.pagination)
		cursor = stringField(pagination?.end_cursor)
		if (!cursor || pagination?.has_next_page === false) return subscribers
	}
	throw new Error('Kit confirmation reconciliation exceeded the 100-page cap')
}

function parseKitFormSubscribers(payload: unknown): KitFormSubscriberRecord[] {
	const record = asRecord(payload)
	const subscribers = Array.isArray(record?.subscribers)
		? record.subscribers
		: []
	return subscribers.flatMap((value) => {
		const subscriber = asRecord(value)
		const id =
			stringField(subscriber?.id) ??
			(typeof subscriber?.id === 'number' ? String(subscriber.id) : undefined)
		const email =
			stringField(subscriber?.email_address) ?? stringField(subscriber?.email)
		const state = stringField(subscriber?.state)
		const createdAt = stringField(subscriber?.created_at)
		const addedAt =
			stringField(subscriber?.added_at) ??
			stringField(subscriber?.subscribed_at) ??
			stringField(asRecord(subscriber?.subscription)?.created_at) ??
			createdAt
		if (
			!id ||
			!email ||
			!createdAt ||
			!addedAt ||
			!isKitSubscriberState(state)
		) {
			return []
		}
		return [
			{
				kitSubscriberId: id,
				email,
				firstName: stringField(subscriber?.first_name),
				createdAt,
				addedAt,
				state,
				fields: asRecord(subscriber?.fields),
			},
		]
	})
}

function isKitSubscriberState(
	value: string | undefined,
): value is SignupGapKitSubscriberState {
	return KIT_SUBSCRIBER_STATES.some((state) => state === value)
}

function asRecord(value: unknown) {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: undefined
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function chunk<T>(items: T[], size: number) {
	const chunks: T[][] = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}
