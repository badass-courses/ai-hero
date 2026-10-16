import type { DrovrContactProfileSyncRequested } from '@/inngest/events/drovr'

import { createHash } from 'node:crypto'

import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

import type { ContactProfileVersion, LegacyProfileAcknowledgement } from './contact-profile-version'
import type { AckEvidenceExpired } from './contact-sync-profile-ack-schema'
import type { ProfileAckPreparation, ProfileAckProducerCompletion, ProfileAckProducerPorts, ProfileAckPublication } from './contact-sync-profile-ack-registration'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'

import {
	birthThenRedeliver,
	contactSyncRetryRequest,
} from './contact-sync-straggler-retry'
import { parseDrovrProfileSyncConfig } from './drovr-contact-profile-sync-requests'

import {
	findEvergreenOffer,
	readContactSendStanding,
	type DrovrPersonalizeRepository,
} from './drovr-personalize'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import type { DeferredDrovrEvent } from './drovr-shadow-delivery'
import { SKILLS_WORKFLOW_EMAIL_STEPS } from './skills-workflow-path'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'
import {
	buildValuePathEmailPersonalization,
	VALUE_PATH_SEND_TIME_FIELDS,
	valuePathEmailLinkWindow,
} from './value-path-email-executor'
import type { ValuePathLinkAnchorStore } from './value-path-link-anchor'

/**
 * Contact sync (2026-09-26): drovr stops calling ai-hero's personalize
 * endpoint on every PostShiba send and renders from a profile ai-hero pushes
 * to `org-aihero` / `contact-directory`. The endpoint stays as drovr's
 * fallback, so everything here is built from the same functions it uses.
 *
 * Off until drovr's contact-directory release accepts these event types.
 */

export {
	offerProfileSyncRequests,
	parseDrovrProfileSyncConfig,
	requestContactProfileSync,
	requestContactProfileSyncSafely,
	type DrovrProfileSyncConfig,
} from './drovr-contact-profile-sync-requests'

/**
 * Reasons that stop a send without being a suppression. Suppressions
 * (unsubscribed, bounced, complained, suppressed) have drovr's own rows,
 * the send authority (#324); a hold blocks through the profile.
 */
export const CONTACT_PROFILE_HOLDS = [
	'stale-state',
	'identity-conflict',
	'support-intent',
	'team-sales-intent',
	'contact-email-missing',
] as const

export function contactProfileHolds(reasons: readonly string[]): string[] {
	return CONTACT_PROFILE_HOLDS.filter((hold) => reasons.includes(hold))
}

export type ContactProfile = {
	email: string
	firstName: string | null
	holds: string[]
}

export type ContactLinksIssue = {
	journeyId: string
	emailKey: string
	issuedAt: string
	expiresAt: string
	/** Input-derived only; see sendTimeFields. */
	variables: Record<string, string>
	/** Keys drovr fills with the send's dueAt at render. */
	sendTimeFields: string[]
}

export type ContactOfferIssue = {
	journeyId: string
	emailKey?: string
	couponId: string
	/** The coupon's completion time, not the profile version's timestamp. */
	issuedAt?: string
	variables: Record<string, string>
}

/** Separates the send-time stamps from what the contact's inputs decide. */
export function splitSendTimeFields(fields: Record<string, string>): {
	variables: Record<string, string>
	sendTimeFields: string[]
} {
	const variables: Record<string, string> = {}
	const sendTimeFields: string[] = []
	for (const [key, value] of Object.entries(fields)) {
		if (VALUE_PATH_SEND_TIME_FIELDS.includes(key)) sendTimeFields.push(key)
		else variables[key] = value
	}
	return { variables, sendTimeFields }
}

/**
 * Every email of one value path, issued eagerly: its link window (anchored
 * at the first issue, shared with the live send) and the variables live
 * personalize would answer inside that window. An email whose
 * personalization would be held, or whose anchor store is unavailable, is
 * left out: drovr has no links for it and asks the live endpoint, which
 * answers with the reasons.
 */
export async function buildValuePathJourneyLinks(args: {
	contactId: string
	kitSubscriberId?: string
	valuePathSlug: string
	answerPages: ValuePathAnswerPageResource[]
	baseUrl: string
	pathTokenSecret?: string
	linkAnchors: ValuePathLinkAnchorStore
	now: string
	warn?: (event: string, fields: Record<string, unknown>) => unknown
}): Promise<ContactLinksIssue[]> {
	const links: ContactLinksIssue[] = []
	for (const step of SKILLS_WORKFLOW_EMAIL_STEPS) {
		if (step.valuePathSlug !== args.valuePathSlug) continue
		const inputs = {
			contactId: args.contactId,
			kitSubscriberId: args.kitSubscriberId,
			valuePathSlug: step.valuePathSlug,
			emailResourceId: step.emailResourceId,
			answerPages: args.answerPages,
			baseUrl: args.baseUrl,
			pathTokenSecret: args.pathTokenSecret,
		}
		// Validate before anchoring, as the live send does.
		if (
			!buildValuePathEmailPersonalization({ ...inputs, now: args.now }).passed
		)
			continue
		const window = await valuePathEmailLinkWindow({
			...inputs,
			linkAnchors: args.linkAnchors,
			now: args.now,
			warn: args.warn,
		})
		if (!window) continue
		const personalization = buildValuePathEmailPersonalization({
			...inputs,
			now: args.now,
			linkExpiresAt: window.expiresAt,
		})
		if (!personalization.passed) continue
		links.push({
			journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
			emailKey: step.emailResourceId,
			issuedAt: window.issuedAt,
			expiresAt: window.expiresAt,
			...splitSendTimeFields(personalization.fields),
		})
	}
	return links
}

/**
 * One sync's events at one profileVersion: the profile, then the links and
 * offers it carries. drovr keeps the highest version per contact (and, for
 * links, per journey and email), so a replay or an out-of-order delivery
 * converges; each key is replay-safe on its own.
 *
 * Every key carries the version. drovr takes a link or offer only at a
 * higher version, so an unchanged one re-sent at v+1 must be a new event:
 * under a version-free key it was deduped, the directory kept it at v, and
 * drovr's step 2 read the contact as stale for good.
 */
export function buildContactProfileEvents(args: {
	contactId: string
	profileVersion: number
	occurredAt: string
	profile: ContactProfile
	links: readonly ContactLinksIssue[]
	offers: readonly ContactOfferIssue[]
}): DrovrShadowEvent[] {
	const base = {
		tenantId: DROVR_AUTHORITY_TENANT_ID,
		contactId: args.contactId,
		journeyId: DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
		occurredAt: args.occurredAt,
	} as const
	const { profileVersion } = args
	return [
		{
			...base,
			type: 'contact.profile.updated',
			idempotencyKey: `profile:${args.contactId}:${profileVersion}`,
			payload: { profileVersion, ...args.profile },
		},
		...args.links.map(
			(link): DrovrShadowEvent => ({
				...base,
				type: 'contact.links.issued',
				idempotencyKey: `links:${args.contactId}:${link.journeyId}:${link.emailKey}:v${profileVersion}`,
				payload: { profileVersion, ...link },
			}),
		),
		...args.offers.map(
			({ couponId, issuedAt, ...offer }): DrovrShadowEvent => ({
				...base,
				occurredAt: issuedAt ?? args.occurredAt,
				type: 'contact.offer.issued',
				idempotencyKey: `offer:${args.contactId}:${couponId}:v${profileVersion}`,
				payload: { profileVersion, ...offer },
			}),
		),
	]
}

export type ContactKitIdentity = {
	kitSubscriberId?: string
	identityConflict: boolean
}

/**
 * More than one Kit identity for a contact is ambiguous: never choose a
 * subscriber id arbitrarily when signing an answer link. Shared with the
 * personalize route.
 */
export function kitIdentityOf(
	externalIds: readonly string[],
): ContactKitIdentity {
	if (externalIds.length > 1) return { identityConflict: true }
	const [kitSubscriberId] = externalIds
	return kitSubscriberId
		? { kitSubscriberId, identityConflict: false }
		: { identityConflict: false }
}

export type ContactProfileSnapshot = {
	occurredAt: string
	profile: ContactProfile
	links: ContactLinksIssue[]
	offers: ContactOfferIssue[]
}

/**
 * One contact's profile as drovr stores it, read through the same functions
 * live personalize answers from. Links are issued only for a contact that
 * can be sent to (a held or suppressed contact records no first issue, as
 * on the live send) and only for the path asked for.
 */
export async function readContactProfileSnapshot(args: {
	repository: DrovrPersonalizeRepository
	contactId: string
	kitIdentity: ContactKitIdentity
	valuePathSlug?: string
	answerPages: ValuePathAnswerPageResource[]
	baseUrl: string
	pathTokenSecret?: string
	linkAnchors: ValuePathLinkAnchorStore
	now: string
	warn?: (event: string, fields: Record<string, unknown>) => unknown
}): Promise<ContactProfileSnapshot | undefined> {
	const standing = await readContactSendStanding({
		repository: args.repository,
		contactId: args.contactId,
		identityConflict: args.kitIdentity.identityConflict,
	})
	if (!standing) return undefined
	const links =
		args.valuePathSlug && standing.reasons.length === 0
			? await buildValuePathJourneyLinks({
					contactId: standing.contact.id,
					kitSubscriberId: args.kitIdentity.kitSubscriberId,
					valuePathSlug: args.valuePathSlug,
					answerPages: args.answerPages,
					baseUrl: args.baseUrl,
					pathTokenSecret: args.pathTokenSecret,
					linkAnchors: args.linkAnchors,
					now: args.now,
					warn: args.warn,
				})
			: []
	const offer = await findEvergreenOffer({
		repository: args.repository,
		contactId: standing.contact.id,
		origin: args.baseUrl,
	})
	return {
		occurredAt: args.now,
		profile: {
			email: standing.email,
			firstName: standing.firstName,
			holds: contactProfileHolds(standing.reasons),
		},
		links,
		offers: offer
			? [{ journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID, ...offer }]
			: [],
	}
}

/**
 * Versioned digest of profile and links only. Offers are independent facts.
 * The prefix distinguishes legacy combined digests without a schema change;
 * the remaining 61 hex digits retain 244 bits of the SHA-256 digest. Read
 * time and input order do not change the digest.
 */
export function contactProfileContentHash(
	snapshot: Pick<ContactProfileSnapshot, 'profile' | 'links' | 'offers'>,
): string {
	const byKey = <T>(items: readonly T[], key: (item: T) => string) =>
		[...items].sort((left, right) => key(left).localeCompare(key(right)))
	return 'v2:' + createHash('sha256')
		.update(
			canonicalJson({
				profile: snapshot.profile,
				links: byKey(
					snapshot.links,
					(link) => `${link.journeyId}\u0000${link.emailKey}`,
				),
				// Offers are independent facts at the current version, never inputs
				// to the version. A new coupon must not invalidate stored links.
			}),
		)
		.digest('hex').slice(0, 61)
}

/** Exact pre-v2 digest, including offers but not their newly added issue time. */
export function legacyContactProfileContentHash(snapshot: ContactProfileSnapshot): string {
	const byKey = <T>(items: readonly T[], key: (item: T) => string) => [...items].sort((a, b) => key(a).localeCompare(key(b)))
	return createHash('sha256').update(canonicalJson({
		profile: snapshot.profile,
		links: byKey(snapshot.links, link => `${link.journeyId}\u0000${link.emailKey}`),
		offers: byKey(snapshot.offers.map(({ issuedAt: _issuedAt, ...offer }) => offer), offer => offer.couponId),
	})).digest('hex')
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
			)
			.join(',')}}`
	}
	return JSON.stringify(value ?? null)
}

export type ContactProfileSyncReceipt =
	| { status: 'skipped'; reason: string }
	| {
			status: 'sent'
			profileVersion: number
			links: number
			offers: number
			accepted: number
			rejected: number
	  }
	| { status: 'awaiting-proof'; profileVersion: number; reason: 'receiver-acceptance-unproven' }
	| { status: 'ack-unavailable'; profileVersion: number; reason: string }
	| { status: 'ack-evidence-expired'; profileVersion: number; evidence: AckEvidenceExpired }
	| { status: 'receiver-refused'; profileVersion: number }
	/**
	 * drovr refused the push as event-not-live (or cold-start-unhandled):
	 * nothing recorded, and the same events are scheduled for after its
	 * straggler pass. It does not hold the heartbeat back (contract §3).
	 */
	| {
			status: 'deferred'
			reason: DeferredDrovrEvent['reason']
			profileVersion: number
			deferred: number
	  }

type SyncStep = {
	run<T>(id: string, callback: () => Promise<T>): Promise<unknown>
	sendEvent(id: string, payload: unknown): Promise<unknown>
}

type DeliveryResult =
	| { accepted: number; rejected: number; deferred?: DeferredDrovrEvent[] }
	| 'not-configured'

/**
 * One contact's profile to drovr's contact directory: read it, version it by
 * content, and require whole-contact terminal receiver proof before answering
 * `sent` or acknowledging a profile version. Queue/capture is awaiting-proof,
 * not acceptance or reconciliation coverage. Profile/link
 * changes move the version; coupons read it without writing it. An unchanged
 * acknowledged digest skips, except for a monthly profile-only confirmation. Events addressed to the authority tenant go
 * straight to it: no owner fan-out. Read before versioning, so a missing
 * contact spends no version; per-contact concurrency of one keeps a higher
 * version carrying newer content. Network/5xx failures use SDK retry; healthy
 * migration deferrals and unproved queue handoffs remain unacknowledged.
 */
export async function runContactProfileSync(args: {
	event: Pick<DrovrContactProfileSyncRequested, 'data'>
	step: SyncStep
	env: Readonly<Record<string, string | undefined>>
	readSnapshot: (request: {
		contactId: string
		valuePathSlug?: string
		offerOnly?: boolean
	}) => Promise<ContactProfileSnapshot | undefined>
	versionFor: (
		contactId: string,
		contentHash: string,
		legacyHash?: string,
	) => Promise<ContactProfileVersion>
	deliver: (events: DrovrShadowEvent[]) => Promise<DeliveryResult>
	/** The value path drovr owns for the contact, when a request names none. */
	ownedPath: (contactId: string) => Promise<string | undefined>
	/** drovr's scope: an owner assignment for a sending journey. */
	onSendingJourney: (contactId: string) => Promise<boolean>
	now?: () => number
	/** Births directory actors drovr answered cold-start-unhandled for (§4). */
	birth: (contactIds: string[]) => Promise<void>
	/** Compatibility only, never called for a registered/ON request. */
	acknowledge: (contactId: string, profileVersion: number, request?: Parameters<LegacyProfileAcknowledgement>[2]) => Promise<void>
	/** Real OFF writer result, including a concurrent known-request fence. */
	acknowledgeLegacy?: LegacyProfileAcknowledgement
	/** Atomic first capture/registration, retained publication and fresh ACK. */
	profileAck?: ProfileAckProducerPorts
	/** Fresh, bounded whole-subsystem flag; omitted/failed/hung reads are OFF. */
	profileAckEnabled?: () => Promise<boolean>
	/** Deprecated compatibility shape. A boolean cannot authorize frozen ACK. */
	proveDelivery?: (input: { contactId: string; profileVersion: number; events: DrovrShadowEvent[] }) => Promise<boolean>
	currentVersion?: (contactId: string) => Promise<(ContactProfileVersion & { contentHash?: string }) | undefined>
}): Promise<ContactProfileSyncReceipt> {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled) return { status: 'skipped', reason: config.reason }
	const { contactId, valuePathSlug } = args.event.data
	if (isSyntheticPrincipalId(contactId)) {
		return { status: 'skipped', reason: 'synthetic-principal' }
	}
	// Only contacts drovr migrated to the v2 directory: anyone else's
	// profile would be refused (409) until drovr's straggler pass.
	const inScope = (await args.step.run('sending-journey', () =>
		args.onSendingJourney(contactId),
	)) as boolean
	if (!inScope) return { status: 'skipped', reason: 'no-sending-journey' }
	const snapshot = (await args.step.run('read-profile', async () =>
		args.readSnapshot({
			contactId,
			valuePathSlug: args.event.data.reason === 'offer-issued' ? undefined : valuePathSlug ?? (await args.ownedPath(contactId)),
			...(args.event.data.reason === 'offer-issued' ? { offerOnly: true } : {}),
		}),
	)) as ContactProfileSnapshot | undefined
	if (!snapshot) return { status: 'skipped', reason: 'contact-missing' }
	// drovr ignores a profile without an email as malformed (contract §2);
	// with none, it falls back to live personalize, which holds the contact.
	if (!snapshot.profile.email.trim())
		return { status: 'skipped', reason: 'contact-email-missing' }
	// Addressed by content: unchanged, this is the last version and when it
	// was set, so the events below are byte-identical to the last push and
	// drovr dedupes them for free.
	const offerOnly = args.event.data.reason === 'offer-issued'
	const version = (await args.step.run('review-profile-version', () =>
		offerOnly ? args.currentVersion?.(contactId) ?? Promise.resolve(undefined) : args.versionFor(contactId, contactProfileContentHash(snapshot), legacyContactProfileContentHash(snapshot)),
	)) as ContactProfileVersion | undefined
	const restate = args.event.data.reason === 'restate' && version?.acknowledged === true && !version.migrated
	// An unseeded directory falls back to live personalize. A coupon cannot
	// manufacture a profile or spend a version, even for a first issue.
	if (!version) return { status: 'skipped', reason: 'profile-not-issued' }
	const { profileVersion, since, acknowledged } = version
	// A proven legacy match rewrites only the digest, never a version or event.
	// Unacknowledged versions take full delivery even on a restatement request.
	if (version.migrated && acknowledged) return { status: 'skipped', reason: 'hash-migrated' }
	if (acknowledged && !offerOnly && !restate)
		return { status: 'skipped', reason: 'unchanged' }
	// A new logical invocation in a covered period cannot recreate the old
	// monthly wire key after seven-day receipt purge or refresh its clock.
	// An original SDK keeps its earlier version-review memo and frozen ref.
	if (restate && version.acknowledgedAt && version.acknowledgedAt.slice(0, 7) >= snapshot.occurredAt.slice(0, 7)) return { status: 'skipped', reason: 'period-already-confirmed' }
	const events = buildContactProfileEvents({
		contactId,
		profileVersion,
		...snapshot,
		links: offerOnly || restate ? [] : snapshot.links,
		// The capped worker refreshes the current offer only after this profile lands.
		offers: offerOnly ? snapshot.offers : [],
		occurredAt: since,
	}).filter((event) => !offerOnly || event.type === 'contact.offer.issued')
	if (restate) {
		const window = snapshot.occurredAt.slice(0, 7)
		for (const event of events) {
			event.idempotencyKey = `profile:${contactId}:${profileVersion}:restate:${window}`
			event.occurredAt = snapshot.occurredAt
		}
	}
	if (events.length === 0) return { status: 'skipped', reason: 'unchanged' }
	const request = restate ? { kind: 'restate' as const, period: snapshot.occurredAt.slice(0, 7) } : { kind: 'delta' as const }
	if (!offerOnly) {
		const enabled = await profileAckFlagEnabled({ readFlag: async () => args.profileAckEnabled?.() ?? false })
		const ports = args.profileAck
		if (!ports && enabled) return { status: 'ack-unavailable', profileVersion, reason: 'registration-adapter-unavailable' }
		if (ports) {
			const registrationEpoch = version.profileAckProtocol === 1 && (version.newlyIssued || restate)
				? await args.step.run('delta-registration-epoch', ports.registrationEpoch) as string
				: undefined
			const prepared = await args.step.run('delta-prepare-frozen-ack', () => ports.prepare({ contactId, version, contentHash: contactProfileContentHash(snapshot), request, events, registrationEpoch })) as ProfileAckPreparation
			if (prepared._tag === 'ProfileAckUnavailable') return { status: 'ack-unavailable', profileVersion, reason: prepared.reason }
			if (prepared._tag === 'ProfileAckCaptured' || prepared._tag === 'ProfileAckKnown') {
				const ref = prepared.ref
				// Even a successful cached SDK result cannot revive forgotten
				// evidence or stand in for fresh admission on a replayed run.
				const denied = await ports.admit(ref)
				if (denied) return { status: 'ack-evidence-expired', profileVersion, evidence: denied }
				if (prepared._tag === 'ProfileAckCaptured') {
					const published = await args.step.run('delta-deliver-profile', () => ports.publish(ref)) as ProfileAckPublication
					if (published._tag === 'AckEvidenceExpired') return { status: 'ack-evidence-expired', profileVersion, evidence: published }
				}
				// Never a pre-read boolean/counter. The actual effect owns the
				// fresh full-membership SQL proof and frozen-clock write together.
				const completed = await args.step.run(`delta-acknowledge-frozen:${ref.requestId}`, () => ports.complete(ref)) as ProfileAckProducerCompletion
				if (completed._tag === 'AckEvidenceExpired') return { status: 'ack-evidence-expired', profileVersion, evidence: completed }
				if (completed._tag === 'ProfileAckReceiverRefused') return { status: 'receiver-refused', profileVersion }
				if (completed._tag !== 'ProfileAckConfirmed') return { status: 'awaiting-proof', profileVersion, reason: 'receiver-acceptance-unproven' }
				return { status: 'sent', profileVersion: ref.profileVersion, links: completed.links, offers: 0, accepted: 0, rejected: 0 }
			}
			// A memoized OFF preparation cannot become an ON registration
			// after legacy publication, or license a fallback NOW-based ACK.
			if (await profileAckFlagEnabled({ readFlag: async () => args.profileAckEnabled?.() ?? false })) return { status: 'ack-unavailable', profileVersion, reason: 'registration-disabled-before-publication' }
		}
	}
	const delivered = (await args.step.run('delta-deliver-profile', () =>
		args.deliver(events),
	)) as DeliveryResult
	if (delivered === 'not-configured') {
		return { status: 'skipped', reason: 'drovr-not-configured' }
	}
	const resolved = await birthThenRedeliver({
		deferred: delivered.deferred ?? [],
		step: args.step,
		birth: args.birth,
		deliver: async (events) => {
			const again = await args.deliver(events)
			if (again === 'not-configured')
				throw new Error('drovr stopped being configured mid-sync')
			return again
		},
	})
	const deferred = resolved.deferred
	const accepted = delivered.accepted + resolved.accepted
	const rejected = delivered.rejected + resolved.rejected
	if (deferred.length > 0) {
		const at = (await args.step.run('defer-at', async () =>
			(args.now ?? Date.now)(),
		)) as number
		// The retry may vouch for this version only if nothing was rejected.
		await args.step.sendEvent(
			'defer-refused',
			contactSyncRetryRequest(
				deferred,
				1,
				at,
				!offerOnly && rejected === 0 ? { contactId, profileVersion } : undefined,
			),
		)
		return {
			status: 'deferred',
			reason: deferred[0]!.reason,
			profileVersion,
			deferred: deferred.length,
		}
	}
	// A final 4xx (a bad key, a refused event) is logged by the delivery
	// and never retried (contract §4); it never reads as sent.
	if (rejected > 0) {
		return { status: 'skipped', reason: 'drovr-rejected' }
	}
	// Reader-first rollout: OFF intentionally retains main's optimistic ACK,
	// avoiding unacknowledged-version resend/recapture storms. It is NOT the
	// new confirmation protocol. ON requires complete native receiver proof.
	if (!offerOnly) {
		const confirmed = await args.step.run('delta-acknowledge-version', async () => {
			const enabled = await profileAckFlagEnabled({ readFlag: async () => args.profileAckEnabled?.() ?? false })
			if (enabled) return false
			if (args.acknowledgeLegacy) return args.acknowledgeLegacy(contactId, profileVersion, request)
			if (restate) await args.acknowledge(contactId, profileVersion, request)
			else await args.acknowledge(contactId, profileVersion)
			return true
		}) as boolean
		if (!confirmed) return { status: 'awaiting-proof', profileVersion, reason: 'receiver-acceptance-unproven' }
	}
	return {
		status: 'sent',
		profileVersion,
		links: events.filter((event) => event.type === 'contact.links.issued').length,
		offers: events.filter((event) => event.type === 'contact.offer.issued').length,
		accepted,
		rejected,
	}
}
