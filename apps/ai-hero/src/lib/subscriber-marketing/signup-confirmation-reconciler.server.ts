import { db } from '@/db'
import { contact, providerIdentity } from '@/db/schema'
import {
	buildSignupConfirmationReconciliationPlan,
	buildSignupGapPreview,
	fetchKitSignupGapPageWithRetry,
	normalizeSignupGapEmail,
	type SignupConfirmationReconciliationPlan,
	type SignupGapKitSubscriber,
	type SignupGapKitSubscriberState,
} from '@/lib/subscriber-marketing/signup-gap-recovery'
import { and, eq, inArray } from 'drizzle-orm'

export const SKILLS_NEWSLETTER_FORM_ID = 9376133
export const SKILLS_CONFIRMATION_RECONCILIATION_START =
	'2026-07-15T00:00:00.000Z'
export const SKILLS_CONFIRMATION_RECONCILIATION_LIMIT = 200

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

export async function buildSignupConfirmationReconciliationBatch(args?: {
	to?: string
	limit?: number
}): Promise<SignupConfirmationReconciliationPlan> {
	const to = new Date(args?.to ?? new Date().toISOString()).toISOString()
	const subscribers = await fetchKitFormSubscribersForStates({
		formId: SKILLS_NEWSLETTER_FORM_ID,
		addedAfter: SKILLS_CONFIRMATION_RECONCILIATION_START,
		states: KIT_SUBSCRIBER_STATES,
	})
	const preview = buildSignupGapPreview({
		subscribers,
		identityMatches: await fetchIdentityMatches(subscribers),
		formId: SKILLS_NEWSLETTER_FORM_ID,
		from: SKILLS_CONFIRMATION_RECONCILIATION_START,
		to,
		now: to,
	})
	return buildSignupConfirmationReconciliationPlan({
		preview,
		limit: args?.limit ?? SKILLS_CONFIRMATION_RECONCILIATION_LIMIT,
	})
}

async function fetchIdentityMatches(subscribers: SignupGapKitSubscriber[]) {
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

	for (const emailChunk of chunk(emails, 500)) {
		const rows = await db
			.select({ email: contact.email })
			.from(contact)
			.where(inArray(contact.email, emailChunk))
		for (const row of rows) {
			const email = normalizeSignupGapEmail(row.email)
			if (email) contactEmails.add(email)
		}
	}
	for (const idChunk of chunk(subscriberIds, 500)) {
		const rows = await db
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
				),
			)
		for (const row of rows) matchedSubscriberIds.add(row.externalId)
	}

	return {
		contactEmails,
		kitSubscriberIds: matchedSubscriberIds,
	}
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
	const apiKey =
		process.env.CONVERTKIT_V4_API_KEY ?? process.env.CONVERTKIT_API_KEY
	if (!apiKey) {
		throw new Error(
			'Confirmation reconciliation requires CONVERTKIT_V4_API_KEY or CONVERTKIT_API_KEY',
		)
	}
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
		if (!id || !email || !createdAt || !addedAt || !isKitSubscriberState(state)) {
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
