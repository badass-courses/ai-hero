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
import type { SideEffectIntent } from './types'

/**
 * drovr owns the unsubscribe; ai-hero applies it to Kit.
 *
 * drovr suppresses the contact and folds `contact.unsubscribed` first, then
 * hands ai-hero a `list.unsubscribe` intent so Kit stops sending too. The
 * Kit account is shared with Total TypeScript, so "all AI Hero email" is
 * never an account-level unsubscribe: it is the `Unsubscribed: AI Hero`
 * tag every AI Hero sequence and broadcast already excludes, the same tag
 * today's Kit footer link applies and the opt-in flow removes.
 *
 * A `course` scope needs no Kit call (drovr's stopped journey adds nothing
 * to Kit again), so it completes with a receipt row and no provider write.
 * The Kit call is one request, so it runs inside this request and the
 * answer is the completion, a retry, or a named block; never 202.
 */

export const LIST_UNSUBSCRIBE_INTENT_KIND = 'list.unsubscribe' as const
export const UNSUBSCRIBE_KIT_LIST_INTENT_TYPE = 'unsubscribe-kit-list' as const

/** How long drovr waits before re-asking after Kit said not now. */
export const KIT_UNSUBSCRIBE_RETRY_MS = 60_000
/** A deployment without the Kit key re-asks on a slow cadence until it has one. */
export const KIT_UNSUBSCRIBE_UNCONFIGURED_RETRY_MS = 15 * 60_000
/** Kit requests time out after 10s; an abandoned sending claim can be recovered later. */
export const KIT_UNSUBSCRIBE_CLAIM_STALE_MS = 10 * 60_000

export const ListUnsubscribePayload = z.object({
	scope: z.enum(['course', 'all']),
	source: z.string().min(1).optional(),
})

export type ListUnsubscribeScope = z.infer<
	typeof ListUnsubscribePayload
>['scope']

export type KitUnsubscribeOutcome = 'tagged' | 'already-tagged' | 'not-in-kit'

/** Applies the all-AI-Hero unsubscribe in Kit for one subscriber. */
export type KitUnsubscriber = (subscriber: {
	email: string
	kitSubscriberId?: string
}) => Promise<KitUnsubscribeOutcome>

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

/**
 * The Kit write: tag the subscriber `Unsubscribed: AI Hero` (v4), by Kit id
 * when ai-hero knows it and by email otherwise. 201 tagged, 200 already
 * tagged, 404 means Kit has no such subscriber and there is nothing to stop.
 * Anything else throws KitV4Error for the caller to classify.
 */
export function createKitUnsubscriber(options: {
	apiKey: string | undefined
	fetch?: Fetcher
	tagId?: string | number
	timeoutMs?: number
}): KitUnsubscriber | undefined {
	const apiKey = options.apiKey?.trim()
	if (!apiKey) return undefined
	const fetcher = options.fetch ?? fetch
	const tagId = options.tagId ?? AI_HERO_UNSUBSCRIBED_TAG_ID
	return async ({ email, kitSubscriberId }) => {
		const byId = kitSubscriberId && /^\d+$/.test(kitSubscriberId)
		const url = byId
			? `https://api.kit.com/v4/tags/${tagId}/subscribers/${kitSubscriberId}`
			: `https://api.kit.com/v4/tags/${tagId}/subscribers`
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(),
			options.timeoutMs ?? 10_000,
		)
		try {
			const response = await fetcher(url, {
				method: 'POST',
				headers: {
					'X-Kit-Api-Key': apiKey,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(byId ? {} : { email_address: email }),
				signal: controller.signal,
			})
			if (response.status === 201) return 'tagged'
			if (response.status === 200) return 'already-tagged'
			if (response.status === 404) return 'not-in-kit'
			// The body can echo the address; the status is enough to act on.
			throw new KitV4Error(response.status, 'tag write refused')
		} finally {
			clearTimeout(timer)
		}
	}
}

const boundedNextActionId = (intentKey: string): string =>
	`drovr:${createHash('sha256').update(intentKey).digest('hex').slice(0, 40)}`

/** One receipt row per contact and scope: `all`, or `course:<journeyId>`. */
export function listUnsubscribeIdempotencyKey(
	contactId: string,
	scope: ListUnsubscribeScope,
	journeyId: string,
): string {
	return `contact:${contactId}:list-unsubscribe:${scope === 'all' ? 'all' : `course:${journeyId}`}`
}

export async function acceptListUnsubscribe(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	tenantId: DrovrTenantId
	now: string
	unsubscribeInKit?: KitUnsubscriber
	findKitSubscriberId?: (contactId: string) => Promise<string | undefined>
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	const payload = ListUnsubscribePayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'unsupported',
			reason: 'list.unsubscribe payload names no scope',
			hint: 'Send { scope: "all" | "course", source }.',
		}
	}
	const { scope } = payload.data
	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }

	const idempotencyKey = listUnsubscribeIdempotencyKey(
		contact.id,
		scope,
		intent.journeyId,
	)
	// The completion is addressed to the actor that asked: drovr refuses a
	// completion for another journey, and several actors may ask for `all`.
	const completionFor = (row: SideEffectIntent): DrovrExecutorResult => ({
		status: 'completed',
		intentId: row.id,
		completion: {
			tenantId: args.tenantId,
			contactId: intent.contactId,
			journeyId: intent.journeyId as DrovrShadowEvent['journeyId'],
			type: 'list.unsubscribed',
			occurredAt:
				stringField(row.completedAt) ??
				stringField(row.metadata.completedAt) ??
				args.now,
			idempotencyKey: `completion:${intent.idempotencyKey}`,
			payload: { scope },
		},
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
				type: UNSUBSCRIBE_KIT_LIST_INTENT_TYPE,
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
					scope,
					...(payload.data.source
						? { unsubscribeSource: payload.data.source }
						: {}),
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
		retryAfterMs = KIT_UNSUBSCRIBE_RETRY_MS,
	): DrovrExecutorResult => ({
		status: 'retry',
		intentId: row.id,
		retryAfterMs,
		reason,
	})
	const afterLostClaim = async (): Promise<DrovrExecutorResult> => {
		const latest = await args.repository.findSideEffectIntentByIdempotencyKey(
			idempotencyKey,
		)
		if (latest?.status === 'completed') return completionFor(latest)
		if (latest?.status === 'blocked') {
			return {
				status: 'blocked',
				intentId: latest.id,
				reviewReasons: latest.reviewReasons,
			}
		}
		return retry('kit-unsubscribe-in-flight')
	}

	// No provider write (or completion) without an atomic claim and a guarded finish.
	if (
		!args.repository.claimSideEffectIntentForSend ||
		!args.repository.finishClaimedSideEffectIntent
	) {
		return retry('kit-unsubscribe-claim-unavailable')
	}
	const lastAttemptAt = stringField(row.metadata.lastAttemptAt)
	if (row.status === 'failed' && lastAttemptAt) {
		const remaining =
			Date.parse(lastAttemptAt) + KIT_UNSUBSCRIBE_RETRY_MS - Date.parse(args.now)
		if (Number.isFinite(remaining) && remaining > 0) {
			return retry('kit-unsubscribe-retry-due', remaining)
		}
	}
	if (scope === 'course') {
		const claimed = await args.repository.claimSideEffectIntentForSend(row.id, {
			now: args.now,
			staleAfterMs: KIT_UNSUBSCRIBE_CLAIM_STALE_MS,
		})
		if (!claimed) return afterLostClaim()
		const completed = await finish(args.repository, row, {
			status: 'completed',
			metadata: { kitCall: 'none' },
			now: args.now,
		})
		return completed ? completionFor(completed) : afterLostClaim()
	}

	if (!args.unsubscribeInKit) {
		return retry('kit-unsubscribe-not-configured', KIT_UNSUBSCRIBE_UNCONFIGURED_RETRY_MS)
	}
	const claimed = await args.repository.claimSideEffectIntentForSend(row.id, {
		now: args.now,
		staleAfterMs: KIT_UNSUBSCRIBE_CLAIM_STALE_MS,
	})
	if (!claimed) return afterLostClaim()

	const email = contact.email?.trim()
	if (!email) {
		const blocked = await finish(args.repository, row, {
			status: 'blocked',
			reviewReasons: ['contact-email-missing'],
			now: args.now,
		})
		return blocked
			? { status: 'blocked', intentId: blocked.id, reviewReasons: blocked.reviewReasons }
			: afterLostClaim()
	}

	const kitSubscriberId =
		stringField(row.metadata.kitSubscriberId) ??
		(await args.findKitSubscriberId?.(contact.id))
	let outcome: KitUnsubscribeOutcome
	try {
		outcome = await args.unsubscribeInKit({ email, kitSubscriberId })
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
		const blocked = await finish(args.repository, row, {
			status: 'blocked',
			reviewReasons: [`kit-unsubscribe-refused:${status}`],
			now: args.now,
		})
		return blocked
			? { status: 'blocked', intentId: blocked.id, reviewReasons: blocked.reviewReasons }
			: afterLostClaim()
	}
	const completed = await finish(args.repository, row, {
		status: 'completed',
		metadata: {
			kitCall: outcome,
			kitTagId: AI_HERO_UNSUBSCRIBED_TAG_ID,
			...(kitSubscriberId ? { kitSubscriberId } : {}),
		},
		now: args.now,
	})
	return completed ? completionFor(completed) : afterLostClaim()
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
	const next: SideEffectIntent = {
		...row,
		status: outcome.status,
		completedAt,
		reviewReasons: outcome.reviewReasons ?? [],
		metadata: {
			...row.metadata,
			...outcome.metadata,
			...(completedAt ? { completedAt } : { lastAttemptAt: outcome.now }),
		},
	}
	if (!repository.finishClaimedSideEffectIntent) return undefined
	return await repository.finishClaimedSideEffectIntent(row.id, outcome.now, {
		status: next.status,
		completedAt: next.completedAt,
		gates: next.gates,
		reviewReasons: next.reviewReasons,
		metadata: next.metadata,
	})
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}
