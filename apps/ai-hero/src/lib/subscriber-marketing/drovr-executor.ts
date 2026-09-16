import { z } from 'zod'

import { createInternalId } from '../internal-id'
import type { CaptureMarketingRepository } from './capture-contact-event'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SHADOW_TENANT_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrShadowEvent,
	type DrovrTenantId,
} from './drovr-shadow-emitter'
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
	payload: z.record(z.unknown()).optional(),
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
	| { status: 'blocked'; intentId: string; reviewReasons: string[] }

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

export async function acceptDrovrIntent(args: {
	repository: DrovrExecutorRepository
	intent: DrovrIntent
	now?: string
	/** Optional lookup for the contact's Kit subscriber id (provider identity). */
	findKitSubscriberId?: (contactId: string) => Promise<string | undefined>
}): Promise<DrovrExecutorResult> {
	const { intent } = args
	const now = args.now ?? new Date().toISOString()

	if (intent.kind !== 'email.send') {
		return {
			status: 'unsupported',
			reason: `intent kind ${intent.kind} has no ai-hero executor`,
			hint: 'Only email.send for the skills course is executed here today.',
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
	if (intent.journeyId !== DROVR_SKILLS_COURSE_JOURNEY_ID) {
		return {
			status: 'unsupported',
			reason: `journey ${intent.journeyId} has no ai-hero executor`,
			hint: `Only ${DROVR_SKILLS_COURSE_JOURNEY_ID} is executed here today.`,
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
		return existingIntentResult(existing)
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
	const created = await args.repository.createSideEffectIntent({
		id: createInternalId(),
		nextActionId: `drovr:${intent.idempotencyKey}`,
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
	return {
		status: 'accepted',
		intentId: created.id,
		idempotencyKey,
		created: true,
	}
}

function existingIntentResult(existing: SideEffectIntent): DrovrExecutorResult {
	if (existing.status === 'completed' || isValuePathIntentCompleted(existing)) {
		const completion = drovrCompletionForIntent(existing)
		if (completion) {
			return { status: 'completed', intentId: existing.id, completion }
		}
		// A legacy-planned completion has no drovr owner to route to; the
		// caller learns it is done and drovr's own executor completion path
		// carries the fold.
		return {
			status: 'accepted',
			intentId: existing.id,
			idempotencyKey: existing.idempotencyKey,
			created: false,
		}
	}
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
