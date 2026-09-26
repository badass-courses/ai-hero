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

export {
	offerProfileSyncRequests,
	parseDrovrProfileSyncConfig,
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
		...args.links.map(
			(link): DrovrShadowEvent => ({
				...base,
				type: 'contact.links.issued',
				idempotencyKey: `links:${args.contactId}:${link.journeyId}:${link.emailKey}:${link.issuedAt}`,
				payload: { profileVersion, ...link },
			}),
		),
		...args.offers.map(
			({ couponId, ...offer }): DrovrShadowEvent => ({
				...base,
				type: 'contact.offer.issued',
				idempotencyKey: `offer:${args.contactId}:${couponId}`,
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
