import {
	DROVR_CONTACT_PROFILE_SYNC_EVENT,
	type DrovrContactProfileSyncRequested,
} from '@/inngest/events/drovr'

import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

import type { CouponIssueResult } from './drovr-evergreen-coupon'
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

export type DrovrProfileSyncConfig =
	{ enabled: true } | { enabled: false; reason: string }

export function parseDrovrProfileSyncConfig(
	env: Readonly<Record<string, string | number | undefined>>,
): DrovrProfileSyncConfig {
	const flag = String(env.AIH_DROVR_PROFILE_SYNC ?? '')
		.trim()
		.toLowerCase()
	if (flag !== 'true' && flag !== '1') {
		return { enabled: false, reason: 'AIH_DROVR_PROFILE_SYNC is not set' }
	}
	return { enabled: true }
}

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
		...args.links.map((link): DrovrShadowEvent => ({
			...base,
			type: 'contact.links.issued',
			idempotencyKey: `links:${args.contactId}:${link.journeyId}:${link.emailKey}:${link.issuedAt}`,
			payload: { profileVersion, ...link },
		})),
		...args.offers.map(({ couponId, ...offer }): DrovrShadowEvent => ({
			...base,
			type: 'contact.offer.issued',
			idempotencyKey: `offer:${args.contactId}:${couponId}`,
			payload: { profileVersion, ...offer },
		})),
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

type ProfileSyncRequest = DrovrContactProfileSyncRequested['data']

/**
 * Ask for one contact's profile sync, off the host's path: a no-op while
 * the flag is off, and a failed send never reaches the caller. A lost
 * request is repaired by the ContactEvent reconcile.
 */
export function requestContactProfileSyncSafely(
	request: ProfileSyncRequest,
	options: {
		env?: Readonly<Record<string, string | number | undefined>>
		send?: (event: DrovrContactProfileSyncRequested) => unknown
	} = {},
): void {
	try {
		if (!parseDrovrProfileSyncConfig(options.env ?? process.env).enabled) return
		const send = options.send ?? sendWithInngest
		void Promise.resolve(
			send({ name: DROVR_CONTACT_PROFILE_SYNC_EVENT, data: request }),
		).catch(() => undefined)
	} catch {
		// A profile sync request must never escape into the host flow.
	}
}

/**
 * The awaited request, for a writer that changes a profile input without a
 * ContactEvent the reconcile scans: its sync must not be silently lost, so a
 * failed send is logged at error (the reconcile's watermark would otherwise
 * over-claim). Still never throws into the host flow.
 */
export async function requestContactProfileSync(
	request: ProfileSyncRequest,
	options: {
		env?: Readonly<Record<string, string | number | undefined>>
		send?: (event: DrovrContactProfileSyncRequested) => unknown
		error?: (event: string, fields: Record<string, unknown>) => unknown
	} = {},
): Promise<'requested' | 'off' | 'failed'> {
	if (!parseDrovrProfileSyncConfig(options.env ?? process.env).enabled)
		return 'off'
	try {
		await (options.send ?? sendWithInngest)({
			name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
			data: request,
		})
		return 'requested'
	} catch (failure) {
		try {
			const error = options.error ?? (await import('@/server/logger')).log.error
			await error('drovr.profile_sync.request_failed', {
				contactId: request.contactId,
				reason: request.reason,
				error: failure instanceof Error ? failure.message : String(failure),
			})
		} catch {
			// Logging cannot make the request land.
		}
		return 'failed'
	}
}

async function sendWithInngest(event: DrovrContactProfileSyncRequested) {
	const { inngest } = await import('@/inngest/inngest.server')
	return inngest.send(event)
}

/**
 * One offer sync per coupon a sender run issued. The sender sends these as
 * a durable step: a coupon is not a ContactEvent, so the reconcile would
 * never repair a lost request.
 */
export function offerProfileSyncRequests(
	results: readonly CouponIssueResult[],
	config: DrovrProfileSyncConfig,
): DrovrContactProfileSyncRequested[] {
	if (!config.enabled) return []
	return results.flatMap((result) =>
		result.status === 'completed'
			? [
					{
						name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
						data: { contactId: result.contactId, reason: 'offer-issued' },
					},
				]
			: [],
	)
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

type SyncStep = {
	run: <T>(id: string, callback: () => Promise<T>) => Promise<unknown>
}

type DeliveryResult = { accepted: number; rejected: number } | 'not-configured'

/**
 * One contact's profile to drovr's contact directory: read it, bump its
 * version once, and post the events, answering `sent` only once drovr took
 * them (the contact-sync reconcile's watermark relies on that). Events
 * addressed to the authority tenant go straight to it: no owner fan-out.
 * Read before the bump, so a missing contact spends no version; per-contact
 * concurrency of one keeps a higher version carrying newer content. A 5xx,
 * a network failure or drovr's 409 event-not-live throws, and the step
 * retries.
 */
export async function runContactProfileSync(args: {
	event: Pick<DrovrContactProfileSyncRequested, 'data'>
	step: SyncStep
	env: Readonly<Record<string, string | undefined>>
	readSnapshot: (request: {
		contactId: string
		valuePathSlug?: string
	}) => Promise<ContactProfileSnapshot | undefined>
	bump: (contactId: string) => Promise<number>
	deliver: (events: DrovrShadowEvent[]) => Promise<DeliveryResult>
	/** The value path drovr owns for the contact, when a request names none. */
	ownedPath: (contactId: string) => Promise<string | undefined>
}): Promise<ContactProfileSyncReceipt> {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled) return { status: 'skipped', reason: config.reason }
	const { contactId, valuePathSlug } = args.event.data
	if (isSyntheticPrincipalId(contactId)) {
		return { status: 'skipped', reason: 'synthetic-principal' }
	}
	const snapshot = (await args.step.run('read-profile', async () =>
		args.readSnapshot({
			contactId,
			valuePathSlug: valuePathSlug ?? (await args.ownedPath(contactId)),
		}),
	)) as ContactProfileSnapshot | undefined
	if (!snapshot) return { status: 'skipped', reason: 'contact-missing' }
	const profileVersion = (await args.step.run('bump-profile-version', () =>
		args.bump(contactId),
	)) as number
	const events = buildContactProfileEvents({
		contactId,
		profileVersion,
		...snapshot,
	})
	const delivered = (await args.step.run('deliver-profile', () =>
		args.deliver(events),
	)) as DeliveryResult
	if (delivered === 'not-configured') {
		return { status: 'skipped', reason: 'drovr-not-configured' }
	}
	return {
		status: 'sent',
		profileVersion,
		links: snapshot.links.length,
		offers: snapshot.offers.length,
		...delivered,
	}
}
