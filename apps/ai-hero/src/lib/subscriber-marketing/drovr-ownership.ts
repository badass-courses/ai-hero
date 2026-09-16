import { createHash } from 'node:crypto'

import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SHADOW_TENANT_ID,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import type { CaptureMarketingRepository } from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'
import type { ContactEventRecord, SideEffectIntent } from './types'

/**
 * Who drives a contact's skills-course journey: the legacy in-app planner
 * or drovr. Ownership is decided once, at signup, and recorded as a
 * contact event so every later reader (the emitter, the reconciler, the
 * durable delivery function) sees the same answer without a flag lookup.
 *
 * A drovr-owned contact never gets a legacy Email 0 plan and is skipped by
 * the legacy drip reconciler; drovr's actor emits each send as an intent
 * that ai-hero executes. The ownership event itself is the contact's birth
 * in drovr's authority tenant (see the emitter), so there is exactly one
 * birth per owned contact and no race with the shadow birth.
 *
 * Rollout is a deterministic percentage bucket on the contact id plus an
 * explicit email allowlist for the smoke pass. Default 0%, nobody: the
 * cutover plan's decision 3 (one smoke, then 100%, no canary).
 */

export const JOURNEY_OWNER_ASSIGNED_EVENT_TYPE =
	'journey.owner.assigned' as const

export type JourneyOwner = 'drovr' | 'legacy'

export type DrovrOwnershipConfig = {
	/** 0..100; the share of new signups routed to drovr. */
	percent: number
	/** Lowercased emails always routed to drovr, regardless of percent. */
	emails: ReadonlySet<string>
}

export const DROVR_OWNERSHIP_OFF: DrovrOwnershipConfig = {
	percent: 0,
	emails: new Set(),
}

export function parseDrovrOwnershipConfig(
	env: Readonly<Record<string, string | number | undefined>>,
): DrovrOwnershipConfig {
	const raw = Number(env.AIH_DROVR_OWNER_PERCENT ?? 0)
	const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
	const emails = new Set(
		String(env.AIH_DROVR_OWNER_EMAILS ?? '')
			.split(',')
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email.length > 0),
	)
	return { percent, emails }
}

/** Stable 0..99 bucket so a contact lands on the same side of any percent. */
export function ownershipBucket(contactId: string): number {
	const digest = createHash('sha256').update(contactId).digest('hex')
	return Number.parseInt(digest.slice(0, 8), 16) % 100
}

export function decideJourneyOwner(args: {
	contactId: string
	email?: string
	config: DrovrOwnershipConfig
}): JourneyOwner {
	const email = args.email?.trim().toLowerCase()
	if (email && args.config.emails.has(email)) return 'drovr'
	if (args.config.percent <= 0) return 'legacy'
	return ownershipBucket(args.contactId) < args.config.percent
		? 'drovr'
		: 'legacy'
}

type OwnershipReadRepository = Pick<
	CaptureMarketingRepository,
	'findContactEventsByType'
>

/**
 * The recorded owner, if ownership was ever assigned to drovr. A
 * repository that cannot read events by type (some dry-run fakes) has
 * nothing recorded.
 */
export async function findRecordedJourneyOwner(
	repository: OwnershipReadRepository,
	contactId: string,
): Promise<JourneyOwner | undefined> {
	if (!repository.findContactEventsByType) return undefined
	const events = await repository.findContactEventsByType(
		contactId,
		JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
	)
	return events.length > 0 ? 'drovr' : undefined
}

export type JourneyOwnerResolution = {
	owner: JourneyOwner
	/** True when the assignment already exists and must not be recorded again. */
	recorded: boolean
}

/**
 * Ownership is sticky and never flips a contact the legacy planner already
 * started. A recorded assignment wins; a replayed signup for a contact
 * that already has a legacy course entry stays legacy; only a genuinely
 * new signup is decided by the rollout config.
 */
export async function resolveJourneyOwner(args: {
	repository: OwnershipReadRepository
	contactId: string
	email?: string
	alreadyEntered: boolean
	config: DrovrOwnershipConfig
}): Promise<JourneyOwnerResolution> {
	const recorded = await findRecordedJourneyOwner(
		args.repository,
		args.contactId,
	)
	if (recorded) return { owner: recorded, recorded: true }
	if (args.alreadyEntered) return { owner: 'legacy', recorded: false }
	return { owner: decideJourneyOwner(args), recorded: false }
}

export function journeyOwnerProviderEventId(contactId: string): string {
	return `drovr-owner:${contactId}:value-path-skills-course`
}

/**
 * Record the assignment. Idempotent on the semantic key, so a retried
 * signup records it once; the repository's own dispatch turns the new
 * event into the authority-tenant birth.
 */
export async function recordJourneyOwnerAssigned(args: {
	repository: Pick<CaptureMarketingRepository, 'createContactEvent'>
	contactId: string
	providerIdentityId: string
	kitSubscriberId: string
	email: string
	name?: string
	occurredAt: string
}): Promise<ContactEventRecord> {
	const normalized = normalizeContactEvent({
		provider: 'kit',
		providerEventId: journeyOwnerProviderEventId(args.contactId),
		eventType: JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
		occurredAt: args.occurredAt,
		email: args.email,
		name: args.name,
		externalId: args.kitSubscriberId,
		message: 'Journey owner assigned to drovr for the skills course',
		privacyLevel: 'internal',
	})
	return args.repository.createContactEvent({
		...normalized,
		contactId: args.contactId,
		providerIdentityId: args.providerIdentityId,
		createdAt: args.occurredAt,
	})
}

/** An intent drovr planned through the executor endpoint. */
export function isDrovrOwnedIntent(intent: SideEffectIntent): boolean {
	const owner = intent.metadata.drovr
	return (
		typeof owner === 'object' &&
		owner !== null &&
		typeof (owner as Record<string, unknown>).tenantId === 'string'
	)
}

/**
 * Shadow-addressed facts about a drovr-owned contact also go to the
 * authority tenant, where the owning actor folds them. Births are the one
 * exception: the ownership event is the only authority birth, so the
 * shadow birth is never copied. Copies get their own idempotency key so
 * drovr's per-tenant dedupe cannot confuse them with the shadow's.
 */
export function fanOutOwnedEvents(
	events: readonly DrovrShadowEvent[],
	ownedContactIds: ReadonlySet<string>,
): DrovrShadowEvent[] {
	const copies = events.flatMap((event) =>
		event.tenantId === DROVR_SHADOW_TENANT_ID &&
		event.type !== 'contact.created' &&
		ownedContactIds.has(event.contactId)
			? [
					{
						...event,
						tenantId: DROVR_AUTHORITY_TENANT_ID,
						idempotencyKey: `owner:${event.idempotencyKey}`,
					},
				]
			: [],
	)
	return [...events, ...copies]
}
