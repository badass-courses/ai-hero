import { createHash } from 'node:crypto'

import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_TENANT_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrJourneyId,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import type { CaptureMarketingRepository } from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'
import type { ContactEventRecord, Provider, SideEffectIntent } from './types'

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
	/**
	 * Lowercased emails captured but not entered: no legacy plan, no drovr
	 * assignment. Moving one to `emails` and replaying its signup enters it
	 * as drovr-owned. Wins over `emails`, so a half-moved address stays held.
	 */
	holdEmails?: ReadonlySet<string>
}

export const DROVR_OWNERSHIP_OFF: DrovrOwnershipConfig = {
	percent: 0,
	emails: new Set(),
}

/**
 * The rollout is off, whatever the knobs say, until drovr is reachable
 * for the authority tenant: the ingest URL and that tenant's bearer key.
 * Routing a signup to drovr with either missing would suppress the legacy
 * Email 0 and then drop or reject the birth at delivery, leaving the
 * contact owned by nobody.
 */
export function parseDrovrOwnershipConfig(
	env: Readonly<Record<string, string | number | undefined>>,
): DrovrOwnershipConfig {
	const present = (value: string | number | undefined) =>
		String(value ?? '').trim().length > 0
	const emailList = (value: string | number | undefined) =>
		new Set(
			String(value ?? '')
				.split(',')
				.map((email) => email.trim().toLowerCase())
				.filter((email) => email.length > 0),
		)
	// A hold never routes anywhere, so it applies even while drovr is unreachable.
	const holdEmails = emailList(env.AIH_DROVR_OWNER_HOLD_EMAILS)
	const hold = holdEmails.size > 0 ? { holdEmails } : {}
	if (
		!present(env.DROVR_SHADOW_INGEST_URL) ||
		!present(env.DROVR_API_KEY_ORG_AIHERO)
	) {
		return { ...DROVR_OWNERSHIP_OFF, ...hold }
	}
	const raw = Number(env.AIH_DROVR_OWNER_PERCENT ?? 0)
	const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
	return { percent, emails: emailList(env.AIH_DROVR_OWNER_EMAILS), ...hold }
}

/** True when the signup is to be captured and held, not entered. */
export function isHeldSignup(
	config: DrovrOwnershipConfig,
	email: string | undefined,
): boolean {
	const normalized = email?.trim().toLowerCase()
	return Boolean(normalized && config.holdEmails?.has(normalized))
}

/**
 * What an entry logs about the ownership config it resolved, so a surprise
 * (a held address that entered anyway) can be traced to the config the
 * deployment actually read. Counts and booleans only, never an address.
 */
export function ownershipDecisionLog(
	config: DrovrOwnershipConfig,
	email: string | undefined,
) {
	const normalized = email?.trim().toLowerCase()
	return {
		holdHit: isHeldSignup(config, email),
		holdEmails: config.holdEmails?.size ?? 0,
		ownerEmailHit: Boolean(normalized && config.emails.has(normalized)),
		ownerEmails: config.emails.size,
		ownerPercent: config.percent,
	}
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
	return events.some((event) => journeyOwnerAssignmentJourneyId(event))
		? 'drovr'
		: undefined
}

export async function findJourneyOwnerAssignment(
	repository: OwnershipReadRepository,
	contactId: string,
	journeyId: DrovrJourneyId = DROVR_SKILLS_COURSE_JOURNEY_ID,
): Promise<ContactEventRecord | undefined> {
	if (!repository.findContactEventsByType) return undefined
	const events = await repository.findContactEventsByType(
		contactId,
		JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
	)
	return events.find(
		(event) => journeyOwnerAssignmentJourneyId(event) === journeyId,
	)
}

export type JourneyOwnerResolution =
	| { owner: 'legacy'; recorded: false }
	| { owner: 'drovr'; recorded: false }
	/** The assignment already exists; re-dispatch it rather than record again. */
	| { owner: 'drovr'; recorded: true; assignment: ContactEventRecord }

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
	const assignment = await findJourneyOwnerAssignment(
		args.repository,
		args.contactId,
	)
	if (assignment) return { owner: 'drovr', recorded: true, assignment }
	if (args.alreadyEntered) return { owner: 'legacy', recorded: false }
	return { owner: decideJourneyOwner(args), recorded: false }
}

export function journeyOwnerProviderEventId(
	contactId: string,
	journeyId: DrovrJourneyId = DROVR_SKILLS_COURSE_JOURNEY_ID,
): string {
	return `drovr-owner:${contactId}:${journeyId}`
}

export function journeyOwnerAssignmentJourneyId(
	event: Pick<ContactEventRecord, 'providerEventId'>,
): DrovrJourneyId | undefined {
	if (event.providerEventId.endsWith(`:${DROVR_SKILLS_COURSE_JOURNEY_ID}`)) {
		return DROVR_SKILLS_COURSE_JOURNEY_ID
	}
	if (event.providerEventId.endsWith(`:${DROVR_EVERGREEN_OFFER_JOURNEY_ID}`)) {
		return DROVR_EVERGREEN_OFFER_JOURNEY_ID
	}
	if (event.providerEventId.endsWith(`:${DROVR_SHADOW_NEWSLETTER_JOURNEY_ID}`)) {
		return DROVR_SHADOW_NEWSLETTER_JOURNEY_ID
	}
	return undefined
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
	provider?: Provider
	providerExternalId?: string
	email: string
	name?: string
	occurredAt: string
	journeyId?: DrovrJourneyId
}): Promise<ContactEventRecord> {
	const journeyId = args.journeyId ?? DROVR_SKILLS_COURSE_JOURNEY_ID
	const normalized = normalizeContactEvent({
		provider: args.provider ?? 'kit',
		providerEventId: journeyOwnerProviderEventId(args.contactId, journeyId),
		eventType: JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
		occurredAt: args.occurredAt,
		email: args.email,
		name: args.name,
		externalId: args.providerExternalId ?? args.kitSubscriberId,
		message: `Journey owner assigned to drovr for ${journeyId}`,
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
 * Shadow-addressed facts that the authority tenant must also hear. The
 * ownership assignment remains the only authority birth for the course
 * journeys; the shadow-newsletter birth is the deliberate exception because
 * the same journey must run as parity in shadow and as the real sender in
 * authority. Email completions are excluded: an owned contact's sends are
 * drovr-planned, and those already complete straight to the owner under
 * drovr's own completion key; copying the shadow mirror would fold the same
 * completion twice.
 */
export function isShadowNewsletterBirth(event: DrovrShadowEvent): boolean {
	return (
		event.tenantId === DROVR_SHADOW_TENANT_ID &&
		event.journeyId === DROVR_SHADOW_NEWSLETTER_JOURNEY_ID &&
		event.type === 'contact.created'
	)
}

export function isOwnerFanOutCandidate(event: DrovrShadowEvent): boolean {
	if (isShadowNewsletterBirth(event)) return true
	return (
		event.tenantId === DROVR_SHADOW_TENANT_ID &&
		event.type !== 'contact.created' &&
		event.type !== 'email.completed' &&
		(event.type !== 'course.sequence-exhausted' ||
			event.journeyId === DROVR_EVERGREEN_OFFER_JOURNEY_ID)
	)
}

/**
 * Shadow-addressed facts about a drovr-owned contact also go to the
 * authority tenant, where the owning actor folds them. Copies get their
 * own idempotency key so drovr's per-tenant dedupe cannot confuse them
 * with the shadow's.
 */
export function fanOutOwnedEvents(
	events: readonly DrovrShadowEvent[],
	ownedContactIds: ReadonlySet<string>,
	newsletterOwnedContactIds: ReadonlySet<string>,
): DrovrShadowEvent[] {
	// A newsletter birth is a handoff, not parity telemetry. It is allowed
	// only for contacts with a shadow-newsletter ownership assignment;
	// skills-course or evergreen ownership alone must not migrate a Kit
	// veteran. Keep the original-before-copy ordering used by the other
	// owner-routed facts.
	const retained = events.filter((event) => {
		if (!isShadowNewsletterBirth(event)) return true
		return newsletterOwnedContactIds.has(event.contactId)
	})
	const copies = retained.flatMap((event) => {
		const owned = isShadowNewsletterBirth(event)
			? newsletterOwnedContactIds.has(event.contactId)
			: ownedContactIds.has(event.contactId)
		return isOwnerFanOutCandidate(event) && owned
			? [
					{
						...event,
						tenantId: DROVR_AUTHORITY_TENANT_ID,
						idempotencyKey: `owner:${event.idempotencyKey}`,
					},
				]
			: []
	})
	return [...retained, ...copies]
}
