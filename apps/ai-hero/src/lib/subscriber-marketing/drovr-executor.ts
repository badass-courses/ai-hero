import { createHash } from 'node:crypto'
import { z } from 'zod'

import { retryAfterMsFor, type DrovrSendBudget } from './drovr-sync-send'
import {
	isDueRetryableValuePathEmailIntent,
	type ValuePathEmailExecutionResult,
} from './value-path-email-executor'

import {
	EvergreenListPayload,
	evergreenSequenceForList,
	evergreenSequenceForMessage,
	SEND_EVERGREEN_EMAIL_INTENT_TYPE,
	SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
	type DrovrEvergreenConfig,
} from './drovr-evergreen'
import {
	CouponIssuePayload,
	ISSUE_EVERGREEN_COUPON_INTENT_TYPE,
} from './drovr-evergreen-coupon'

import { createInternalId } from '../internal-id'
import { drovrFailureReason } from './drovr-failure'
import type { CaptureMarketingRepository } from './capture-contact-event'
import {
	acceptListUnsubscribe,
	LIST_UNSUBSCRIBE_INTENT_KIND,
	type KitUnsubscriber,
} from './drovr-list-unsubscribe'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SHADOW_TENANT_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrShadowEvent,
	type DrovrTenantId,
} from './drovr-shadow-emitter'
import {
	SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE,
	SHADOW_NEWSLETTER_CATALOG_REVISION,
	ShadowNewsletterSendPayload,
	shadowNewsletterSequenceForMessage,
} from './drovr-shadow-newsletter'
import {
	getSkillsWorkflowEmailStep,
	SKILLS_WORKFLOW_EMAIL_STEPS,
	type SkillsWorkflowEmailStep,
} from './skills-workflow-path'
import type { SideEffectIntent } from './types'
import { isValuePathIntentCompleted } from './value-path-completion'

/**
 * drovr decides, ai-hero executes.
 *
 * drovr's ContactActor emits an `email.send` intent; this module turns it
 * into the same `send-value-path-email` SideEffectIntent row the legacy
 * planner writes, under the legacy idempotency key. The existing executor
 * cron then applies every gate (allowlist, email-7, personalization, Kit
 * pacing) and sends exactly as it does today, and its completion routes
 * back to the owning drovr tenant. Reusing the legacy key means the intent
 * table itself is the double-send guard: if both planners ever decide the
 * same email for the same contact, there is one row.
 *
 * The provider is never named by drovr. ai-hero resolves the step table,
 * the Kit sequence, and the contact's Kit identity itself.
 */

export const DrovrIntentSchema = z.object({
	tenantId: z.string().min(1),
	contactId: z.string().min(1),
	journeyId: z.string().min(1),
	kind: z.string().min(1),
	idempotencyKey: z.string().min(1),
	dueAt: z.string().min(1),
	payload: z.record(z.string(), z.unknown()).optional(),
})

export type DrovrIntent = z.infer<typeof DrovrIntentSchema>

/** What a drovr-owned intent row remembers about its origin. */
export type DrovrIntentOwner = {
	tenantId: DrovrTenantId
	journeyId: string
	intentKey: string
	dueAt: string
}

export type DrovrExecutorRepository = Pick<
	CaptureMarketingRepository,
	| 'findContactById'
	| 'findSideEffectIntentByIdempotencyKey'
	| 'createSideEffectIntent'
> &
	Partial<
		Pick<
			CaptureMarketingRepository,
			| 'updateSideEffectIntent'
			| 'claimSideEffectIntentForSend'
			| 'finishClaimedSideEffectIntent'
		>
	> &
	Required<
		Pick<
			CaptureMarketingRepository,
			'findValuePathEmailSideEffectIntentsByContact'
		>
	>

const knownTenant = (value: unknown): DrovrTenantId | undefined =>
	value === DROVR_SHADOW_TENANT_ID || value === DROVR_AUTHORITY_TENANT_ID
		? value
		: undefined

/** A terminal row must not masquerade as accepted on a drovr redrive. */
function terminalFailureResult(row: SideEffectIntent): DrovrExecutorResult {
	return { status: 'failed', intentId: row.id, ...drovrFailureReason(row) }
}

export type DrovrExecutorResult =
	| { status: 'unsupported'; reason: string; hint: string }
	| { status: 'contact-missing' }
	| {
			status: 'accepted'
			intentId: string
			idempotencyKey: string
			created: boolean
	  }
	| { status: 'completed'; intentId: string; completion: DrovrShadowEvent }
	| { status: 'blocked'; intentId?: string; reviewReasons: string[] }
	| { status: 'failed'; intentId: string; reasonClass: string; reason: string }
	| {
			/** Not now: Kit or the send budget said wait. drovr arms for retryAfterMs. */
			status: 'retry'
			intentId: string
			retryAfterMs: number
			reason: string
	  }

/**
 * The synchronous send: run the value-path executor on the row this
 * request created or found, inside the request. Absent, the cron sends.
 */
export type DrovrSendNow = (
	row: SideEffectIntent,
) => Promise<ValuePathEmailExecutionResult>

const EmailSendPayload = z.object({
	emailResourceId: z.string().min(1),
})

export function drovrOwnerFromMetadata(
	metadata: Record<string, unknown>,
): DrovrIntentOwner | undefined {
	const owner = metadata.drovr
	if (!owner || typeof owner !== 'object') return undefined
	const record = owner as Record<string, unknown>
	const tenantId = knownTenant(record.tenantId)
	const journeyId = stringField(record.journeyId)
	const intentKey = stringField(record.intentKey)
	const dueAt = stringField(record.dueAt)
	if (!tenantId || !journeyId || !intentKey || !dueAt) return undefined
	return { tenantId, journeyId, intentKey, dueAt }
}

/**
 * The completion drovr folds: same shape drovr's own executors return,
 * keyed `completion:<intent key>` so a replayed completion is a no-op.
 */
export function drovrCompletionForIntent(
	intent: SideEffectIntent,
): DrovrShadowEvent | undefined {
	const owner = drovrOwnerFromMetadata(intent.metadata)
	if (!owner) return undefined
	const emailResourceId = stringField(intent.metadata.emailResourceId)
	if (!emailResourceId) return undefined
	const completedAt =
		stringField(intent.completedAt) ??
		stringField(intent.metadata.completedAt) ??
		new Date().toISOString()
	return {
		tenantId: owner.tenantId,
		contactId: intent.contactId,
		journeyId: owner.journeyId as DrovrShadowEvent['journeyId'],
		type: 'email.completed',
		occurredAt: completedAt,
		idempotencyKey: `completion:${owner.intentKey}`,
		// drovr's guard matches on the individual resource id it planned.
		payload: {
			emailResourceId: canonicalIndividualResourceId(emailResourceId),
		},
	}
}

/** Clock skew tolerated between drovr's fold time and this endpoint. */
const DUE_AT_SKEW_MS = 5 * 60_000

export async function acceptDrovrIntent(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	now?: string
	/** Optional lookup for the contact's Kit subscriber id (provider identity). */
	findKitSubscriberId?: (contactId: string) => Promise<string | undefined>
	/** Evergreen bridge and pitch rollout; absent means off. */
	evergreen?: DrovrEvergreenConfig
	/** Send inside the request (skills course email.send only); absent means the cron sends. */
	sendNow?: DrovrSendNow
	/** drovr's share of the Kit key; over budget answers retry before any send. */
	budget?: DrovrSendBudget
	/** Applies an all-AI-Hero unsubscribe in Kit; absent answers retry. */
	unsubscribeInKit?: KitUnsubscriber
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	const now = args.now ?? new Date().toISOString()
	// drovr times sends with wakes and posts an intent when it is due; the
	// sender cron drains pending rows without consulting dueAt. A future
	// dueAt is therefore refused rather than sent early or scheduled here.
	const dueInMs = Date.parse(intent.dueAt) - Date.parse(now)
	if (Number.isNaN(dueInMs) || dueInMs > DUE_AT_SKEW_MS) {
		return {
			status: 'unsupported',
			reason: Number.isNaN(dueInMs)
				? `dueAt ${intent.dueAt} is not a timestamp`
				: `intent is due at ${intent.dueAt}, ${Math.round(dueInMs / 60_000)} minutes ahead; the sender would deliver it now`,
			hint: 'Post an intent when it is due. drovr schedules the wait with a wake, not with dueAt.',
		}
	}

	const tenantId = knownTenant(intent.tenantId)
	if (!tenantId) {
		return {
			status: 'unsupported',
			reason: `tenant ${intent.tenantId} is not one ai-hero executes for`,
			hint: `Known tenants: ${DROVR_AUTHORITY_TENANT_ID}, ${DROVR_SHADOW_TENANT_ID}.`,
		}
	}

	// Any actor may ask (the contact directory for `all`, a journey for its
	// course), so the unsubscribe is routed by kind, not by journey.
	if (intent.kind === LIST_UNSUBSCRIBE_INTENT_KIND) {
		return await acceptListUnsubscribe({
			repository: args.repository,
			intent,
			tenantId,
			now,
			unsubscribeInKit: args.unsubscribeInKit,
			findKitSubscriberId: args.findKitSubscriberId,
		})
	}

	if (intent.journeyId === DROVR_EVERGREEN_OFFER_JOURNEY_ID) {
		return await acceptEvergreenSend({
			repository: args.repository,
			intent,
			tenantId,
			now,
			evergreen: args.evergreen,
			findKitSubscriberId: args.findKitSubscriberId,
		})
	}

	if (intent.journeyId === DROVR_SHADOW_NEWSLETTER_JOURNEY_ID) {
		return await acceptShadowNewsletterSend({
			repository: args.repository,
			intent,
			tenantId,
			now,
			findKitSubscriberId: args.findKitSubscriberId,
		})
	}

	if (intent.kind !== 'email.send') {
		return {
			status: 'unsupported',
			reason: `intent kind ${intent.kind} has no ai-hero executor`,
			hint: 'The skills course executes email.send here; the evergreen journey also executes coupon.issue; any journey may send list.unsubscribe.',
		}
	}
	if (intent.journeyId !== DROVR_SKILLS_COURSE_JOURNEY_ID) {
		return {
			status: 'unsupported',
			reason: `journey ${intent.journeyId} has no ai-hero executor`,
			hint: `Journeys executed here: ${DROVR_SKILLS_COURSE_JOURNEY_ID}, ${DROVR_EVERGREEN_OFFER_JOURNEY_ID}, ${DROVR_SHADOW_NEWSLETTER_JOURNEY_ID}.`,
		}
	}
	const payload = EmailSendPayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'unsupported',
			reason: 'email.send payload is missing emailResourceId',
			hint: 'Send { emailResourceId: "ai-hero-skills-workflow.email-N" }.',
		}
	}

	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }

	const priorIntents =
		await args.repository.findValuePathEmailSideEffectIntentsByContact(
			intent.contactId,
		)
	const latest = priorIntents.at(-1)
	const step = resolveStepForContact(payload.data.emailResourceId, latest)
	if (!step) {
		return {
			status: 'unsupported',
			reason: `unknown skills course email ${payload.data.emailResourceId}`,
			hint: 'Use an emailResourceId from the skills workflow step table.',
		}
	}

	const idempotencyKey = `contact:${contact.id}:value-path:${step.valuePathSlug}:email:${step.emailResourceId}`
	const existing =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existing) {
		await reopenStalePreflightBlock(existing, args.repository)
		await adoptLegacyIntent(existing, intent, {
			repository: args.repository,
			tenantId,
		})
		return await sendNowIfAccepted(
			existingIntentResult(existing, intent, step),
			args,
			step,
			now,
		)
	}

	const kitSubscriberId =
		stringField(latest?.metadata.kitSubscriberId) ??
		(await args.findKitSubscriberId?.(contact.id))
	const owner: DrovrIntentOwner = {
		tenantId,
		journeyId: intent.journeyId,
		intentKey: intent.idempotencyKey,
		dueAt: intent.dueAt,
	}
	let created: SideEffectIntent
	try {
		created = await args.repository.createSideEffectIntent({
			id: createInternalId(),
			// Bounded: the column is 255 chars and drovr keys are unbounded
			// text, so the link back is a stable digest of the key.
			nextActionId: `drovr:${createHash('sha256').update(intent.idempotencyKey).digest('hex').slice(0, 40)}`,
			contactId: contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey,
			gates: [],
			reviewReasons: [],
			metadata: {
				source: 'drovr',
				drovr: owner,
				valuePathSlug: step.valuePathSlug,
				emailResourceId: step.emailResourceId,
				kitSequenceId: step.kitSequenceId,
				...(kitSubscriberId ? { kitSubscriberId } : {}),
				...carryForward(latest?.metadata),
			},
			createdAt: now,
		})
	} catch (cause) {
		// Two posts for the same email raced past the read; the unique key
		// held, so the row that won is the answer, exactly as if it had been
		// found first. Anything else is a real failure.
		const raced =
			await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		if (!raced) throw cause
		await reopenStalePreflightBlock(raced, args.repository)
		await adoptLegacyIntent(raced, intent, {
			repository: args.repository,
			tenantId,
		})
		return await sendNowIfAccepted(
			existingIntentResult(raced, intent, step),
			args,
			step,
			now,
		)
	}
	return await sendNowIfAccepted(
		{
			status: 'accepted',
			intentId: created.id,
			idempotencyKey,
			created: true,
		},
		args,
		step,
		now,
	)
}

/** A sender that has held a row this long without finishing has crashed. */
export const SEND_CLAIM_STALE_MS = 10 * 60_000

/**
 * The synchronous path. An accepted row is sent right here when the caller
 * supplied sendNow: the row is claimed atomically first (pending or failed
 * becomes sending, so the cron and a concurrent post both step back), then
 * the executor's own preflight, gates, personalization, Kit call, and row
 * update run unchanged, and its outcome becomes the wire answer. The
 * budget slot is taken before the send and given back when no Kit call
 * happened (gates refused). A row the executor cannot act on now (a failed
 * row whose retry is not due, or one another sender holds) stays accepted:
 * drovr's deadline re-asks.
 */
async function sendNowIfAccepted(
	result: DrovrExecutorResult,
	args: {
		repository: DrovrExecutorRepository
		intent: DrovrIntent
		sendNow?: DrovrSendNow
		budget?: DrovrSendBudget
	},
	step: SkillsWorkflowEmailStep,
	now: string,
): Promise<DrovrExecutorResult> {
	if (result.status !== 'accepted' || !args.sendNow) return result
	const row = await args.repository.findSideEffectIntentByIdempotencyKey(
		result.idempotencyKey,
	)
	if (!row) return result
	const due =
		row.status === 'pending' ||
		row.status === 'sending' ||
		isDueRetryableValuePathEmailIntent(row, now)
	if (!due) return result
	if (args.repository.claimSideEffectIntentForSend) {
		const claimed = await args.repository.claimSideEffectIntentForSend(row.id, {
			now,
			staleAfterMs: SEND_CLAIM_STALE_MS,
		})
		if (!claimed) return result
	}
	if (args.budget) {
		const budget = await args.budget.take()
		if (!budget.ok) {
			await releaseClaim(args.repository, row)
			return {
				status: 'retry',
				intentId: result.intentId,
				retryAfterMs: budget.retryAfterMs,
				reason: 'send-budget-spent',
			}
		}
	}
	let outcome: ValuePathEmailExecutionResult
	try {
		// The executor sees the row as it was before the claim: it only acts
		// on pending or due-retryable rows, and every outcome overwrites the
		// claim with completed, blocked, or failed.
		outcome = await args.sendNow({
			...row,
			status: row.status === 'sending' ? 'pending' : row.status,
		})
	} catch (cause) {
		await releaseClaim(args.repository, row)
		await args.budget?.refund()
		throw cause
	}
	if (outcome.status === 'blocked' || outcome.status === 'skipped') {
		// No Kit call happened: give the slot back.
		await args.budget?.refund()
	}
	const after =
		(await args.repository.findSideEffectIntentByIdempotencyKey(
			result.idempotencyKey,
		)) ?? row
	switch (outcome.status) {
		case 'completed':
			return existingIntentResult(after, args.intent, step)
		case 'blocked':
			return {
				status: 'blocked',
				intentId: result.intentId,
				reviewReasons: outcome.reviewReasons,
			}
		case 'failed':
			return terminalFailureResult(after)
		case 'retryable-failed':
			return {
				status: 'retry',
				intentId: result.intentId,
				retryAfterMs: retryAfterMsFor(
					stringField(after.metadata.nextRetryAt),
					now,
				),
				reason: stringField(after.metadata.retryReason) ?? 'kit-retryable',
			}
		default:
			if (after.status === 'sending') await releaseClaim(args.repository, row)
			return result
	}
}

/** Put a claimed row back as it was, so the cron or the next re-ask can take it. */
async function releaseClaim(
	repository: DrovrExecutorRepository,
	row: SideEffectIntent,
): Promise<void> {
	if (!repository.updateSideEffectIntent) return
	await repository.updateSideEffectIntent(row.id, {
		status: row.status,
		gates: row.gates,
		reviewReasons: row.reviewReasons,
		metadata: row.metadata,
		completedAt: row.completedAt,
	})
}

/**
 * The inline completion is always addressed to the request in hand: its
 * tenant and its intent key. The row may have been planned by the legacy
 * planner (no owner) or by an earlier drovr transition (another key); in
 * both cases the email was sent, and drovr's fold matches on the
 * emailResourceId, so the requester gets a completion it can fold.
 */
/**
 * A row the legacy planner created for a contact drovr owns (a quiz answer
 * or drip that raced the actor's intent). Stamp drovr's ownership on it so
 * its completion flows back to the actor; without it the emitter has no
 * owner to complete to and the actor waits forever. A completed row needs
 * no stamp: the executor answers it with the completion directly.
 */
/**
 * Refusals the send preflight re-derives from current rows, not from the
 * contact's answers or the campaign: a row blocked only for these was
 * refused for a fact that may since have changed (the state row now
 * exists). Re-open it so the executor runs preflight again; if the fact
 * still holds it blocks again, so the reset is safe to repeat.
 */
const STALE_PREFLIGHT_REASONS = new Set(['contact-state-missing'])

async function reopenStalePreflightBlock(
	existing: SideEffectIntent,
	repository: DrovrExecutorRepository,
): Promise<void> {
	if (
		existing.status !== 'blocked' ||
		existing.reviewReasons.length === 0 ||
		!existing.reviewReasons.every((reason) =>
			STALE_PREFLIGHT_REASONS.has(reason),
		) ||
		!repository.updateSideEffectIntent
	) {
		return
	}
	const reopened = await repository.updateSideEffectIntent(existing.id, {
		status: 'pending',
		completedAt: null,
		gates: existing.gates,
		reviewReasons: [],
		metadata: { ...existing.metadata, reopenedFrom: existing.reviewReasons },
	})
	Object.assign(existing, reopened)
}

async function adoptLegacyIntent(
	existing: SideEffectIntent,
	intent: DrovrIntent,
	args: { repository: DrovrExecutorRepository; tenantId: DrovrTenantId },
): Promise<void> {
	if (
		existing.metadata.drovr ||
		existing.status === 'completed' ||
		!args.repository.updateSideEffectIntent
	) {
		return
	}
	await args.repository.updateSideEffectIntent(existing.id, {
		status: existing.status,
		completedAt: existing.completedAt ?? null,
		gates: existing.gates,
		reviewReasons: existing.reviewReasons,
		metadata: {
			...existing.metadata,
			source: 'drovr',
			adoptedFrom: 'legacy-planner',
			drovr: {
				tenantId: args.tenantId,
				journeyId: intent.journeyId,
				intentKey: intent.idempotencyKey,
				dueAt: intent.dueAt,
			},
		},
	})
}

function existingIntentResult(
	existing: SideEffectIntent,
	request: DrovrIntent,
	step: SkillsWorkflowEmailStep,
): DrovrExecutorResult {
	if (existing.status === 'completed' || isValuePathIntentCompleted(existing)) {
		const completedAt =
			stringField(existing.completedAt) ??
			stringField(existing.metadata.completedAt) ??
			new Date().toISOString()
		const tenantId = knownTenant(request.tenantId)
		if (!tenantId) {
			return {
				status: 'unsupported',
				reason: `tenant ${request.tenantId} is not one ai-hero executes for`,
				hint: `Known tenants: ${DROVR_AUTHORITY_TENANT_ID}, ${DROVR_SHADOW_TENANT_ID}.`,
			}
		}
		return {
			status: 'completed',
			intentId: existing.id,
			completion: {
				tenantId,
				contactId: existing.contactId,
				journeyId: request.journeyId as DrovrShadowEvent['journeyId'],
				type: 'email.completed',
				occurredAt: completedAt,
				idempotencyKey: `completion:${request.idempotencyKey}`,
				payload: {
					emailResourceId: canonicalIndividualResourceId(step.emailResourceId),
				},
			},
		}
	}
	if (existing.status === 'failed' && existing.metadata.retryable !== true)
		return terminalFailureResult(existing)
	if (
		existing.status === 'pending' ||
		existing.status === 'sending' ||
		existing.status === 'failed'
	) {
		return {
			status: 'accepted',
			intentId: existing.id,
			idempotencyKey: existing.idempotencyKey,
			created: false,
		}
	}
	return {
		status: 'blocked',
		intentId: existing.id,
		reviewReasons: existing.reviewReasons,
	}
}

/**
 * drovr plans on the individual step table. A contact the click path
 * already routed onto the team path keeps its team emails: the same
 * position, the team resource id and Kit sequence.
 */
function resolveStepForContact(
	emailResourceId: string,
	latest: SideEffectIntent | undefined,
): SkillsWorkflowEmailStep | undefined {
	const requested = getSkillsWorkflowEmailStep(emailResourceId)
	if (!requested) return undefined
	const latestSlug = stringField(latest?.metadata.valuePathSlug)
	if (!latestSlug || latestSlug === requested.valuePathSlug) return requested
	const position = emailPosition(requested.emailResourceId)
	if (position === undefined) return requested
	return (
		SKILLS_WORKFLOW_EMAIL_STEPS.find(
			(step) =>
				step.valuePathSlug === latestSlug &&
				emailPosition(step.emailResourceId) === position,
		) ?? requested
	)
}

function emailPosition(emailResourceId: string): number | undefined {
	const match = emailResourceId.match(/email-(\d+)$/)
	return match ? Number(match[1]) : undefined
}

function canonicalIndividualResourceId(emailResourceId: string): string {
	const position = emailPosition(emailResourceId)
	return position === undefined
		? emailResourceId
		: `ai-hero-skills-workflow.email-${position}`
}

function carryForward(metadata: Record<string, unknown> | undefined) {
	if (!metadata) return {}
	return {
		...(metadata.courseEntryEventId
			? { courseEntryEventId: metadata.courseEntryEventId }
			: {}),
		...(metadata.courseDeadlineTimeZone
			? { courseDeadlineTimeZone: metadata.courseDeadlineTimeZone }
			: {}),
	}
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

const EvergreenSendPayload = z.object({
	messageId: z.string().min(1),
	slot: z.string().optional(),
})

const boundedNextActionId = (intentKey: string): string =>
	`drovr:${createHash('sha256').update(intentKey).digest('hex').slice(0, 40)}`

/**
 * An evergreen bridge or pitch send: one row for the evergreen sender,
 * keyed per contact and message so a redriven intent never queues the
 * same message twice. drovr's evergreen journey does not wait on this
 * completion (its cadence is the calendar), but the completion is still
 * posted so the receipt log shows the send.
 */
async function acceptEvergreenSend(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	tenantId: DrovrTenantId
	now: string
	evergreen: DrovrEvergreenConfig | undefined
	findKitSubscriberId?: (contactId: string) => Promise<string | undefined>
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	if (!args.evergreen?.enabled) {
		return {
			status: 'unsupported',
			reason: `evergreen sends are not enabled: ${args.evergreen?.reason ?? 'off'}`,
			hint: 'Set AIH_DROVR_EVERGREEN_ENABLED=true once the Kit sequences read back ready.',
		}
	}
	if (intent.kind === 'coupon.issue') {
		return await acceptEvergreenCoupon(args)
	}
	if (intent.kind === 'list.subscribe') {
		return await acceptEvergreenListSubscribe(args)
	}
	if (intent.kind !== 'email.send') {
		return {
			status: 'unsupported',
			reason: `intent kind ${intent.kind} has no evergreen executor`,
			hint: 'email.send, coupon.issue and list.subscribe are executed.',
		}
	}
	const payload = EvergreenSendPayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'unsupported',
			reason: 'email.send payload is missing messageId',
			hint: 'Send { messageId: "<evergreen message id>" }.',
		}
	}
	const sequence = evergreenSequenceForMessage(payload.data.messageId)
	if (!sequence) {
		return {
			status: 'unsupported',
			reason: `unknown evergreen message ${payload.data.messageId}`,
			hint: 'Use a message id from the evergreen bridge/pitch plan.',
		}
	}
	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }

	const idempotencyKey = `contact:${contact.id}:evergreen:${sequence.messageId}`
	const completionFor = (row: SideEffectIntent): DrovrExecutorResult => ({
		status: 'completed',
		intentId: row.id,
		completion: {
			tenantId: args.tenantId,
			contactId: row.contactId,
			journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			type: 'email.completed',
			occurredAt:
				stringField(row.completedAt) ??
				stringField(row.metadata.completedAt) ??
				args.now,
			idempotencyKey: `completion:${intent.idempotencyKey}`,
			payload: { messageId: sequence.messageId },
		},
	})
	const existingResult = (row: SideEffectIntent): DrovrExecutorResult =>
		row.status === 'completed'
			? completionFor(row)
			: row.status === 'failed'
				? terminalFailureResult(row)
				: { status: 'accepted', intentId: row.id, idempotencyKey, created: false }

	const existing =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existing) return existingResult(existing)

	const kitSubscriberId = args.findKitSubscriberId
		? await args.findKitSubscriberId(contact.id)
		: undefined
	let created: SideEffectIntent
	try {
		created = await args.repository.createSideEffectIntent({
			id: createInternalId(),
			nextActionId: boundedNextActionId(intent.idempotencyKey),
			contactId: contact.id,
			provider: 'kit',
			type: SEND_EVERGREEN_EMAIL_INTENT_TYPE,
			status: 'pending',
			idempotencyKey,
			gates: [],
			reviewReasons: [],
			metadata: {
				source: 'drovr',
				drovr: {
					tenantId: args.tenantId,
					journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
					intentKey: intent.idempotencyKey,
					dueAt: intent.dueAt,
				},
				messageId: sequence.messageId,
				slot: sequence.slot,
				kitSequenceId: String(sequence.sequenceId),
				...(kitSubscriberId ? { kitSubscriberId } : {}),
			},
			createdAt: args.now,
		})
	} catch (cause) {
		const raced =
			await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		if (!raced) throw cause
		return existingResult(raced)
	}
	return {
		status: 'accepted',
		intentId: created.id,
		idempotencyKey,
		created: true,
	}
}

/**
 * The shadow-newsletter send: one row per contact and catalog message. The
 * sequence sender adds the contact to the mapped one-email Kit sequence; the
 * completion carries the message id back so the journey marks exactly the
 * message that was in flight as seen.
 */
async function acceptShadowNewsletterSend(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	tenantId: DrovrTenantId
	now: string
	findKitSubscriberId?: (contactId: string) => Promise<string | undefined>
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	if (intent.kind !== 'email.send') {
		return {
			status: 'unsupported',
			reason: `intent kind ${intent.kind} has no shadow-newsletter executor`,
			hint: 'The shadow-newsletter journey executes email.send.',
		}
	}
	const payload = ShadowNewsletterSendPayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'blocked',
			reviewReasons: [
				'shadow-newsletter-payload-invalid: expected newsletter, catalogRevision, and messageId',
			],
		}
	}
	if (payload.data.catalogRevision !== SHADOW_NEWSLETTER_CATALOG_REVISION) {
		return {
			status: 'blocked',
			reviewReasons: [
				`shadow-newsletter-catalog-revision-unknown:${payload.data.catalogRevision}`,
			],
		}
	}
	const sequence = shadowNewsletterSequenceForMessage(
		payload.data.catalogRevision,
		payload.data.messageId,
	)
	if (!sequence) {
		return {
			status: 'blocked',
			reviewReasons: [
				`shadow-newsletter-message-unknown:${payload.data.messageId}`,
			],
		}
	}
	if (
		payload.data.position !== undefined &&
		payload.data.position !== sequence.position
	) {
		return {
			status: 'blocked',
			reviewReasons: [
				`shadow-newsletter-position-mismatch:${payload.data.messageId}:${payload.data.position}`,
			],
		}
	}
	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }

	const idempotencyKey =
		`contact:${args.tenantId}:${contact.id}:shadow-newsletter:${sequence.messageId}`
	const storedOwnerFor = (row: SideEffectIntent) => {
		const owner = drovrOwnerFromMetadata(row.metadata)
		return owner?.journeyId === DROVR_SHADOW_NEWSLETTER_JOURNEY_ID
			? owner
			: undefined
	}
	const completionFor = (
		row: SideEffectIntent,
		owner: DrovrIntentOwner,
	): DrovrExecutorResult => ({
		status: 'completed',
		intentId: row.id,
		completion: {
			tenantId: owner.tenantId,
			contactId: row.contactId,
			journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
			type: 'email.completed',
			occurredAt:
				stringField(row.completedAt) ??
				stringField(row.metadata.completedAt) ??
				args.now,
			idempotencyKey: `completion:${owner.intentKey}`,
			payload: { messageId: sequence.messageId },
		},
	})
	const existingResult = (row: SideEffectIntent): DrovrExecutorResult => {
		const owner = storedOwnerFor(row)
		if (!owner) {
			return {
				status: 'blocked',
				intentId: row.id,
				reviewReasons: ['shadow-newsletter-owner-missing'],
			}
		}
		return row.status === 'completed'
			? completionFor(row, owner)
			: row.status === 'failed'
				? terminalFailureResult(row)
				: {
						status: 'accepted',
						intentId: row.id,
						idempotencyKey: row.idempotencyKey,
						created: false,
					}
	}
	const existing =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existing) return existingResult(existing)

	const kitSubscriberId = args.findKitSubscriberId
		? await args.findKitSubscriberId(contact.id)
		: undefined
	let created: SideEffectIntent
	try {
		created = await args.repository.createSideEffectIntent({
			id: createInternalId(),
			nextActionId: boundedNextActionId(intent.idempotencyKey),
			contactId: contact.id,
			provider: 'kit',
			type: SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE,
			status: 'pending',
			idempotencyKey,
			gates: [],
			reviewReasons: [],
			metadata: {
				source: 'drovr',
				drovr: {
					tenantId: args.tenantId,
					journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
					intentKey: intent.idempotencyKey,
					dueAt: intent.dueAt,
				},
				newsletter: 'shadow-newsletter',
				catalogRevision: payload.data.catalogRevision,
				messageId: sequence.messageId,
				position: sequence.position,
				kitSequenceId: String(sequence.sequenceId),
				...(kitSubscriberId ? { kitSubscriberId } : {}),
			},
			createdAt: args.now,
		})
	} catch (cause) {
		const raced =
			await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		if (!raced) throw cause
		return existingResult(raced)
	}
	return {
		status: 'accepted',
		intentId: created.id,
		idempotencyKey,
		created: true,
	}
}

/**
 * The list handoff: after purchase or once the pitch window closes the
 * journey hands the contact to the shadow newsletter. One row per contact
 * and list; the drain adds to the list's Kit sequence and the completion
 * (`shadow.entered` for the newsletter) closes the journey.
 */
async function acceptEvergreenListSubscribe(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	tenantId: DrovrTenantId
	now: string
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	const payload = EvergreenListPayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'unsupported',
			reason: 'list.subscribe payload names no known list',
			hint: 'Send { list: "shadow-newsletter" }.',
		}
	}
	const sequence = evergreenSequenceForList(payload.data.list)
	if (!sequence) {
		return {
			status: 'unsupported',
			reason: `unknown evergreen list ${payload.data.list}`,
			hint: 'Use a list from the evergreen handoff plan.',
		}
	}
	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }
	const idempotencyKey = `contact:${contact.id}:evergreen:list:${sequence.list}`
	const completionFor = (row: SideEffectIntent): DrovrExecutorResult => ({
		status: 'completed',
		intentId: row.id,
		completion: {
			tenantId: args.tenantId,
			contactId: row.contactId,
			journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			type:
				sequence.list === 'shadow-newsletter'
					? 'shadow.entered'
					: 'list.subscribed',
			occurredAt:
				stringField(row.completedAt) ??
				stringField(row.metadata.completedAt) ??
				args.now,
			idempotencyKey: `completion:${intent.idempotencyKey}`,
			payload: { list: sequence.list },
		},
	})
	const existingResult = (row: SideEffectIntent): DrovrExecutorResult =>
		row.status === 'completed'
			? completionFor(row)
			: row.status === 'failed'
				? terminalFailureResult(row)
				: { status: 'accepted', intentId: row.id, idempotencyKey, created: false }
	const existing =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existing) return existingResult(existing)
	let created: SideEffectIntent
	try {
		created = await args.repository.createSideEffectIntent({
			id: createInternalId(),
			nextActionId: boundedNextActionId(intent.idempotencyKey),
			contactId: contact.id,
			provider: 'kit',
			type: SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
			status: 'pending',
			idempotencyKey,
			gates: [],
			reviewReasons: [],
			metadata: {
				source: 'drovr',
				drovr: {
					tenantId: args.tenantId,
					journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
					intentKey: intent.idempotencyKey,
					dueAt: intent.dueAt,
				},
				list: sequence.list,
				kitSequenceId: String(sequence.sequenceId),
				...(typeof intent.payload?.timezone === 'string'
					? { timezone: intent.payload.timezone }
					: {}),
				...(typeof intent.payload?.timezoneSource === 'string'
					? { timezoneSource: intent.payload.timezoneSource }
					: {}),
			},
			createdAt: args.now,
		})
	} catch (cause) {
		const raced =
			await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		if (!raced) throw cause
		return existingResult(raced)
	}
	return {
		status: 'accepted',
		intentId: created.id,
		idempotencyKey,
		created: true,
	}
}

/**
 * The Thursday coupon: one row per contact, keyed without the message id
 * because a journey issues exactly one coupon. drovr's v3 intent carries the
 * window and time zone; a v1/v2 intent lacks them and is refused so the
 * actor redrives after the journey is repinned, never with a guessed window.
 */
async function acceptEvergreenCoupon(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	tenantId: DrovrTenantId
	now: string
	findKitSubscriberId?: (contactId: string) => Promise<string | undefined>
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	const payload = CouponIssuePayload.safeParse(intent.payload ?? {})
	if (!payload.success) {
		return {
			status: 'unsupported',
			reason: 'coupon.issue payload lacks the pinned window or time zone',
			hint: 'Evergreen release v3 carries issueAt, expiresAt, timezone, timezoneSource on coupon.issue.',
		}
	}
	const contact = await args.repository.findContactById(intent.contactId)
	if (!contact) return { status: 'contact-missing' }
	const idempotencyKey = `contact:${contact.id}:evergreen:coupon`
	const completionFor = (row: SideEffectIntent): DrovrExecutorResult => {
		const couponId = stringField(row.metadata.couponId)
		const expiresAt = stringField(row.metadata.expiresAt)
		if (!couponId || !expiresAt) {
			return {
				status: 'accepted',
				intentId: row.id,
				idempotencyKey,
				created: false,
			}
		}
		return {
			status: 'completed',
			intentId: row.id,
			completion: {
				tenantId: args.tenantId,
				contactId: row.contactId,
				journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
				type: 'coupon.issued',
				occurredAt:
					stringField(row.completedAt) ??
					stringField(row.metadata.completedAt) ??
					args.now,
				idempotencyKey: `completion:${intent.idempotencyKey}`,
				payload: { couponId, expiresAt },
			},
		}
	}
	const existingResult = (row: SideEffectIntent): DrovrExecutorResult =>
		row.status === 'completed'
			? completionFor(row)
			: row.status === 'failed'
				? terminalFailureResult(row)
				: { status: 'accepted', intentId: row.id, idempotencyKey, created: false }
	const existing =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existing) return existingResult(existing)
	const kitSubscriberId = args.findKitSubscriberId
		? await args.findKitSubscriberId(contact.id)
		: undefined
	let created: SideEffectIntent
	try {
		created = await args.repository.createSideEffectIntent({
			id: createInternalId(),
			nextActionId: boundedNextActionId(intent.idempotencyKey),
			contactId: contact.id,
			provider: 'kit',
			type: ISSUE_EVERGREEN_COUPON_INTENT_TYPE,
			status: 'pending',
			idempotencyKey,
			gates: [],
			reviewReasons: [],
			metadata: {
				source: 'drovr',
				drovr: {
					tenantId: args.tenantId,
					journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
					intentKey: intent.idempotencyKey,
					dueAt: intent.dueAt,
				},
				offer: payload.data,
				...(kitSubscriberId ? { kitSubscriberId } : {}),
			},
			createdAt: args.now,
		})
	} catch (cause) {
		const raced =
			await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		if (!raced) throw cause
		return existingResult(raced)
	}
	return {
		status: 'accepted',
		intentId: created.id,
		idempotencyKey,
		created: true,
	}
}
