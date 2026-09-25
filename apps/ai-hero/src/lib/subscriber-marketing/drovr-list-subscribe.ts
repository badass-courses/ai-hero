import { createHash } from 'node:crypto'
import { z } from 'zod'

import { createInternalId } from '../internal-id'
import { AI_HERO_UNSUBSCRIBED_TAG_ID } from './ai-hero-email-opt-in'
import { KitV4Error } from './drovr-evergreen'
import type {
	DrovrExecutorRepository,
	DrovrExecutorResult,
	DrovrIntent,
} from './drovr-executor'
import type { DrovrShadowEvent, DrovrTenantId } from './drovr-shadow-emitter'
import type { ContactIdentityEvidence, SideEffectIntent } from './types'

/**
 * drovr owns double opt-in; ai-hero mirrors a confirmation into Kit.
 *
 * When a reader confirms on /confirm, drovr folds the confirmation and
 * hands ai-hero a `list.subscribe` intent (journey `double-opt-in`, reason
 * `double-opt-in-confirmed`). ai-hero makes the address an active
 * subscriber on the Kit form, so Kit's sequences reach them, without Kit
 * sending its own confirmation email: Kit's double opt-in on the form is
 * turned off at go-live (contract §4), and the upsert creates the
 * subscriber `active`. A confirmation is fresh consent, so the
 * `Unsubscribed: AI Hero` tag (which every AI Hero sequence excludes) comes
 * off, as the /skills opt-in already does.
 *
 * Kit's upsert never changes an existing subscriber's state, so the state
 * is read back: anything but `active` is a named block, never a claimed
 * success. Like list.unsubscribe the Kit work runs inside this request and
 * answers completed, retry, or blocked; never 202.
 */

export const LIST_SUBSCRIBE_INTENT_KIND = 'list.subscribe' as const
export const DOUBLE_OPT_IN_JOURNEY_ID = 'double-opt-in' as const
export const DOUBLE_OPT_IN_CONFIRMED_REASON = 'double-opt-in-confirmed' as const
export const SUBSCRIBE_KIT_FORM_INTENT_TYPE = 'subscribe-kit-form' as const

/**
 * The one switch for whether a fresh double opt-in re-subscribes someone
 * who earlier unsubscribed from AI Hero (open question for Joel). It is
 * read in two places: the Kit mirror removes the `Unsubscribed: AI Hero`
 * tag on confirm, and personalize lets the confirmation email reach an
 * address with an earlier unsubscribe. A "no" is this line set to false.
 */
export const DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE = true

/** The Kit forms a confirmation may subscribe to: the Skills form only. */
export const DOUBLE_OPT_IN_KIT_FORM_IDS: ReadonlySet<number> = new Set([
	9376133,
])

export const KIT_SUBSCRIBE_RETRY_MS = 60_000
export const KIT_SUBSCRIBE_UNCONFIGURED_RETRY_MS = 15 * 60_000
/** Four Kit requests at 10s each; an abandoned claim is recoverable after this. */
export const KIT_SUBSCRIBE_CLAIM_STALE_MS = 10 * 60_000

export const ListSubscribePayload = z.object({
	confirmedAt: z.string().min(1),
	formId: z.string().min(1),
	kitFormId: z.number().int().positive(),
	reason: z.literal(DOUBLE_OPT_IN_CONFIRMED_REASON),
})

export type KitSubscribeOutcome = {
	kitSubscriberId: string
	/** Kit's state after the writes, read back. */
	state: string
	unsubscribeTagRemoved: boolean
}

/** Makes the address an active subscriber on the Kit form, without Kit's email. */
export type KitFormSubscriber = (subscriber: {
	email: string
	firstName?: string
	kitFormId: number
}) => Promise<KitSubscribeOutcome>

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

const KitSubscriberBody = z.object({
	subscriber: z.object({
		id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
		state: z.string().min(1),
	}),
})

/**
 * Kit v4, in order: upsert the subscriber `active` (`POST /v4/subscribers`),
 * add them to the form by id (`POST /v4/forms/{id}/subscribers/{sid}`),
 * remove the `Unsubscribed: AI Hero` tag (204 removed, 404 not tagged),
 * then read the subscriber back for its state. Every body is parsed at the
 * boundary; any other status throws KitV4Error for the caller to classify.
 */
export function createKitFormSubscriber(options: {
	apiKey: string | undefined
	fetch?: Fetcher
	unsubscribedTagId?: string | number
	/** See DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE. */
	resubscribeAfterUnsubscribe?: boolean
	timeoutMs?: number
}): KitFormSubscriber | undefined {
	const apiKey = options.apiKey?.trim()
	if (!apiKey) return undefined
	const fetcher = options.fetch ?? fetch
	const tagId = options.unsubscribedTagId ?? AI_HERO_UNSUBSCRIBED_TAG_ID
	const removeUnsubscribeTag =
		options.resubscribeAfterUnsubscribe ??
		DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE
	const request = async (
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown,
	) => {
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(),
			options.timeoutMs ?? 10_000,
		)
		try {
			return await fetcher(`https://api.kit.com/v4${path}`, {
				method,
				headers: {
					'X-Kit-Api-Key': apiKey,
					'Content-Type': 'application/json',
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: controller.signal,
			})
		} finally {
			clearTimeout(timer)
		}
	}
	const subscriberFrom = async (response: Response, step: string) => {
		const parsed = KitSubscriberBody.safeParse(
			await response.json().catch(() => undefined),
		)
		if (!parsed.success) {
			throw new KitV4Error(502, `${step}: unreadable subscriber body`)
		}
		return {
			id: String(parsed.data.subscriber.id),
			state: parsed.data.subscriber.state,
		}
	}
	return async ({ email, firstName, kitFormId }) => {
		// The body can echo the address; the status is enough to act on.
		const upsert = await request('POST', '/subscribers', {
			email_address: email,
			...(firstName ? { first_name: firstName } : {}),
			state: 'active',
		})
		if (upsert.status !== 200 && upsert.status !== 201) {
			throw new KitV4Error(upsert.status, 'subscriber upsert refused')
		}
		const { id } = await subscriberFrom(upsert, 'upsert')

		const toForm = await request(
			'POST',
			`/forms/${kitFormId}/subscribers/${id}`,
			{},
		)
		if (toForm.status !== 200 && toForm.status !== 201) {
			throw new KitV4Error(toForm.status, 'form add refused')
		}

		const untag = removeUnsubscribeTag
			? await request('DELETE', `/tags/${tagId}/subscribers/${id}`)
			: undefined
		if (untag && untag.status !== 204 && untag.status !== 404) {
			throw new KitV4Error(untag.status, 'unsubscribe tag removal refused')
		}

		const readBack = await request('GET', `/subscribers/${id}`)
		if (readBack.status !== 200) {
			throw new KitV4Error(readBack.status, 'subscriber read-back refused')
		}
		const { state } = await subscriberFrom(readBack, 'read-back')
		return {
			kitSubscriberId: id,
			state,
			unsubscribeTagRemoved: untag?.status === 204,
		}
	}
}

const boundedNextActionId = (intentKey: string): string =>
	`drovr:${createHash('sha256').update(intentKey).digest('hex').slice(0, 40)}`

/**
 * One receipt row per drovr intent: drovr's retries of an intent reuse its
 * key and find the row, while a new intent (say a later confirmation after
 * an unsubscribe) gets its own row and its own Kit write.
 */
export function listSubscribeIdempotencyKey(
	contactId: string,
	kitFormId: number,
	intentKey: string,
): string {
	const intent = createHash('sha256')
		.update(intentKey)
		.digest('hex')
		.slice(0, 32)
	return `contact:${contactId}:list-subscribe:kit-form:${kitFormId}:${intent}`
}

export async function acceptListSubscribe(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	tenantId: DrovrTenantId
	now: string
	subscribeInKit?: KitFormSubscriber
	/**
	 * Records the Kit subscriber as the contact's Kit identity, so later
	 * course sends find it. Best effort: a failure never undoes the write.
	 */
	linkKitSubscriber?: (
		contactId: string,
		kitSubscriberId: string,
	) => Promise<void>
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	if (intent.journeyId !== DOUBLE_OPT_IN_JOURNEY_ID) {
		return {
			status: 'unsupported',
			reason: `list.subscribe from journey ${intent.journeyId} has no ai-hero executor`,
			hint: `Only ${DOUBLE_OPT_IN_JOURNEY_ID} subscribes an address to a Kit form.`,
		}
	}
	const payload = ListSubscribePayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'unsupported',
			reason: 'list.subscribe payload is not a double opt-in confirmation',
			hint: `Send { confirmedAt, formId, kitFormId, reason: "${DOUBLE_OPT_IN_CONFIRMED_REASON}" }.`,
		}
	}
	const { kitFormId, formId, confirmedAt } = payload.data
	if (!DOUBLE_OPT_IN_KIT_FORM_IDS.has(kitFormId)) {
		return {
			status: 'unsupported',
			reason: `Kit form ${kitFormId} is not a double opt-in form ai-hero subscribes to`,
			hint: `Double opt-in Kit forms: ${[...DOUBLE_OPT_IN_KIT_FORM_IDS].join(', ')}.`,
		}
	}
	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }

	const idempotencyKey = listSubscribeIdempotencyKey(
		contact.id,
		kitFormId,
		intent.idempotencyKey,
	)
	const completionFor = (row: SideEffectIntent): DrovrExecutorResult => ({
		status: 'completed',
		intentId: row.id,
		completion: {
			tenantId: args.tenantId,
			contactId: intent.contactId,
			journeyId: intent.journeyId as DrovrShadowEvent['journeyId'],
			type: 'list.subscribed',
			occurredAt:
				stringField(row.completedAt) ??
				stringField(row.metadata.completedAt) ??
				args.now,
			idempotencyKey: `completion:${intent.idempotencyKey}`,
			payload: { formId, kitFormId },
		},
	})
	const blockedFor = (row: SideEffectIntent): DrovrExecutorResult => ({
		status: 'blocked',
		intentId: row.id,
		reviewReasons: row.reviewReasons,
	})

	let row =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (row?.status === 'completed') return completionFor(row)
	if (!row) {
		try {
			row = await args.repository.createSideEffectIntent({
				id: createInternalId(),
				nextActionId: boundedNextActionId(intent.idempotencyKey),
				contactId: contact.id,
				provider: 'kit',
				type: SUBSCRIBE_KIT_FORM_INTENT_TYPE,
				status: 'pending',
				idempotencyKey,
				gates: [],
				reviewReasons: [],
				metadata: {
					source: 'drovr',
					drovr: {
						tenantId: args.tenantId,
						journeyId: intent.journeyId,
						intentKey: intent.idempotencyKey,
						dueAt: intent.dueAt,
					},
					formId,
					kitFormId,
					confirmedAt,
					reason: DOUBLE_OPT_IN_CONFIRMED_REASON,
				},
				createdAt: args.now,
			})
		} catch (cause) {
			const raced =
				await args.repository.findSideEffectIntentByIdempotencyKey(
					idempotencyKey,
				)
			if (!raced) throw cause
			if (raced.status === 'completed') return completionFor(raced)
			row = raced
		}
	}

	const retry = (
		reason: string,
		retryAfterMs = KIT_SUBSCRIBE_RETRY_MS,
	): DrovrExecutorResult => ({
		status: 'retry',
		intentId: row.id,
		retryAfterMs,
		reason,
	})
	const afterLostClaim = async (): Promise<DrovrExecutorResult> => {
		const latest =
			await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		if (latest?.status === 'completed') return completionFor(latest)
		if (latest?.status === 'blocked') return blockedFor(latest)
		return retry('kit-subscribe-in-flight')
	}

	if (row.status === 'blocked') return blockedFor(row)
	// No provider write (or completion) without an atomic claim and a guarded finish.
	if (
		!args.repository.claimSideEffectIntentForSend ||
		!args.repository.finishClaimedSideEffectIntent
	) {
		return retry('kit-subscribe-claim-unavailable')
	}
	const lastAttemptAt = stringField(row.metadata.lastAttemptAt)
	if (row.status === 'failed' && lastAttemptAt) {
		const remaining =
			Date.parse(lastAttemptAt) + KIT_SUBSCRIBE_RETRY_MS - Date.parse(args.now)
		if (Number.isFinite(remaining) && remaining > 0) {
			return retry('kit-subscribe-retry-due', remaining)
		}
	}
	if (!args.subscribeInKit) {
		return retry(
			'kit-subscribe-not-configured',
			KIT_SUBSCRIBE_UNCONFIGURED_RETRY_MS,
		)
	}
	const claimed = await args.repository.claimSideEffectIntentForSend(row.id, {
		now: args.now,
		staleAfterMs: KIT_SUBSCRIBE_CLAIM_STALE_MS,
	})
	if (!claimed) return afterLostClaim()

	const blocked = async (reason: string) => {
		const finished = await finish(args.repository, row, {
			status: 'blocked',
			reviewReasons: [reason],
			now: args.now,
		})
		return finished ? blockedFor(finished) : afterLostClaim()
	}
	const email = contact.email?.trim()
	if (!email) return blocked('contact-email-missing')

	let outcome: KitSubscribeOutcome
	try {
		outcome = await args.subscribeInKit({
			email,
			firstName: contact.name?.trim().split(/\s+/)[0] || undefined,
			kitFormId,
		})
	} catch (error) {
		const status = error instanceof KitV4Error ? error.status : undefined
		if (status === undefined || status === 429 || status >= 500) {
			const failed = await finish(args.repository, row, {
				status: 'failed',
				metadata: {
					retryReason:
						status === 429
							? 'kit-rate-limited'
							: status
								? `kit-${status}`
								: 'kit-unreachable',
				},
				now: args.now,
			})
			return failed
				? retry(status === 429 ? 'kit-rate-limited' : 'kit-retryable')
				: afterLostClaim()
		}
		return blocked(`kit-subscribe-refused:${status}`)
	}
	if (outcome.state !== 'active') {
		// Kit keeps an existing inactive, cancelled, bounced or complained
		// subscriber in that state; the address is not reachable, so say so.
		return blocked(`kit-subscriber-not-active:${outcome.state}`)
	}
	const completed = await finish(args.repository, row, {
		status: 'completed',
		metadata: {
			kitSubscriberId: outcome.kitSubscriberId,
			kitState: outcome.state,
			unsubscribeTagRemoved: outcome.unsubscribeTagRemoved,
		},
		now: args.now,
	})
	if (completed) {
		await args
			.linkKitSubscriber?.(contact.id, outcome.kitSubscriberId)
			.catch(() => undefined)
	}
	return completed ? completionFor(completed) : afterLostClaim()
}

/**
 * Link a Kit subscriber to the contact unless the Kit id already belongs
 * to a contact (this one or another) or the contact already has a Kit
 * identity. Answers what it did, for the log.
 */
export async function linkKitSubscriberIdentity(
	repository: {
		findProviderIdentity(
			provider: 'kit',
			externalId: string,
		): Promise<{ contactId: string } | undefined>
		findKitSubscriberIdForContact(
			contactId: string,
		): Promise<string | undefined>
		createProviderIdentity(input: {
			contactId: string
			provider: 'kit'
			externalId: string
			evidence: ContactIdentityEvidence
			createdAt: string
			updatedAt: string
		}): Promise<unknown>
	},
	contactId: string,
	kitSubscriberId: string,
	now: string,
): Promise<
	'linked' | 'already-linked' | 'kit-id-taken' | 'contact-has-kit-id'
> {
	const owner = await repository.findProviderIdentity('kit', kitSubscriberId)
	if (owner) {
		return owner.contactId === contactId ? 'already-linked' : 'kit-id-taken'
	}
	if (await repository.findKitSubscriberIdForContact(contactId)) {
		return 'contact-has-kit-id'
	}
	await repository.createProviderIdentity({
		contactId,
		provider: 'kit',
		externalId: kitSubscriberId,
		evidence: {
			providerIdentity: { provider: 'kit', externalId: kitSubscriberId },
			source: 'kit',
			strength: 'strong',
		},
		createdAt: now,
		updatedAt: now,
	})
	return 'linked'
}

/** Record the outcome on the row; a repository without updates keeps the row as is. */
async function finish(
	repository: DrovrExecutorRepository,
	row: SideEffectIntent,
	outcome: {
		status: 'completed' | 'blocked' | 'failed'
		reviewReasons?: string[]
		metadata?: Record<string, unknown>
		now: string
	},
): Promise<SideEffectIntent | undefined> {
	const completedAt = outcome.status === 'completed' ? outcome.now : null
	if (!repository.finishClaimedSideEffectIntent) return undefined
	return await repository.finishClaimedSideEffectIntent(row.id, outcome.now, {
		status: outcome.status,
		completedAt,
		gates: row.gates,
		reviewReasons: outcome.reviewReasons ?? [],
		metadata: {
			...row.metadata,
			...outcome.metadata,
			...(completedAt ? { completedAt } : { lastAttemptAt: outcome.now }),
		},
	})
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}
