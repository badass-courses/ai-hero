import { timingSafeEqual } from 'node:crypto'
import {
	emailPreferenceDefinitions,
	type EmailPreferenceKey,
} from '@/coursebuilder/email-preferences'
import {
	activeContactStops,
	CONTACT_RESUBSCRIBED_EVENT_TYPE,
	CONTACT_UNSUBSCRIBED_EVENT_TYPE,
	type ContactStopSignal,
} from '@/lib/subscriber-marketing/contact-stop-rule'

/**
 * Email preferences answered from AI Hero's own records instead of Kit.
 *
 * - Identity: a Kit link's `sh_kit` is the sha256 of the subscriber's email.
 *   It is checked against the directory email for the link's Kit id
 *   (ProviderIdentity provider=kit), so every historical Kit-signed link
 *   keeps working with Kit out of the request path.
 * - State: drovr's all-scope stops, the contact's local opt-out and DOI lift
 *   ContactEvents, and the local CommunicationPreference row. drovr stays the
 *   authority for every stop; nothing read here lifts one.
 *
 * Consent is sacred. A read that fails, or an identity that cannot be
 * checked, leaves a preference unknown, and unknown never reads as
 * "subscribed". An opt-out is always accepted (see `email-preference-change`).
 */

export type DirectoryContact = {
	id: number
	contactId: string
	email: string
	firstName?: string
}

export type PreferenceLinkVerification =
	| {
			status: 'verified'
			subscriber: {
				id: string
				email_address: string
				contactId: string
			}
	  }
	| {
			status: 'invalid'
			reason: 'missing-kit-params' | 'malformed-link' | 'hash-mismatch'
	  }
	| {
			/** The link may be genuine; nothing local can say. */
			status: 'unverifiable'
			reason: 'unknown-id' | 'directory-unavailable'
	  }

const SH_KIT = /^[0-9a-f]{64}$/

/**
 * Checks a Kit link's `ck_subscriber_id` and `sh_kit` against the directory.
 * `hashEmail` is the same sha256 Kit signs links with.
 */
export async function verifyKitPreferenceLink(
	{ subscriberId, shKit }: { subscriberId?: string; shKit?: string },
	deps: {
		readContact: (kitSubscriberId: string) => Promise<DirectoryContact | null>
		hashEmail: (email: string) => string
	},
): Promise<PreferenceLinkVerification> {
	const id = subscriberId?.trim()
	const hash = shKit?.trim().toLowerCase()
	if (!id || !hash) return { status: 'invalid', reason: 'missing-kit-params' }
	if (!/^\d{1,20}$/.test(id) || !SH_KIT.test(hash)) {
		return { status: 'invalid', reason: 'malformed-link' }
	}

	let contact: DirectoryContact | null
	try {
		contact = await deps.readContact(id)
	} catch {
		return { status: 'unverifiable', reason: 'directory-unavailable' }
	}
	if (!contact) return { status: 'unverifiable', reason: 'unknown-id' }

	const expected = Buffer.from(deps.hashEmail(contact.email))
	const given = Buffer.from(hash)
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
		return { status: 'invalid', reason: 'hash-mismatch' }
	}

	return {
		status: 'verified',
		subscriber: {
			id: String(contact.id),
			email_address: contact.email,
			contactId: contact.contactId,
		},
	}
}

/** The ContactEvents `readLocalEmailPreferences` applies the stop rule to. */
export const PREFERENCE_EVIDENCE_EVENT_TYPES = [
	CONTACT_UNSUBSCRIBED_EVENT_TYPE,
	CONTACT_RESUBSCRIBED_EVENT_TYPE,
] as const

export type LocalPreferenceState =
	| { known: true; subscribed: boolean; stoppedEverything: boolean }
	| { known: false }

export type LocalEmailPreferences = Record<
	EmailPreferenceKey,
	LocalPreferenceState
>

export type LocalPreferenceEvidence = {
	/** drovr's active all-scope stops for the Kit id. Throws when unreadable. */
	readDrovrStops: (kitSubscriberId: string) => Promise<{ reason: string }[]>
	/** The contact's opt-out and lift ContactEvents. */
	readContactEvents: (contactId: string) => Promise<
		{
			eventType: string
			providerReference?: string | null
			occurredAt: string
		}[]
	>
	/** The local preference rows for the address, by preference type name. */
	readPreferenceRows: (
		email: string,
	) => Promise<Map<string, { active: boolean; updatedAt: string }>>
}

const allUnknown = (): LocalEmailPreferences =>
	Object.fromEntries(
		emailPreferenceDefinitions.map((preference) => [
			preference.key,
			{ known: false },
		]),
	) as LocalEmailPreferences

/**
 * The contact's preference state from local evidence and drovr stops. Any
 * failed read leaves every preference unknown.
 */
export async function readLocalEmailPreferences(
	verification: PreferenceLinkVerification,
	deps: LocalPreferenceEvidence,
): Promise<LocalEmailPreferences> {
	if (verification.status !== 'verified') return allUnknown()
	const { subscriber } = verification

	let drovrStops: { reason: string }[]
	let events: Awaited<ReturnType<LocalPreferenceEvidence['readContactEvents']>>
	let rows: Awaited<ReturnType<LocalPreferenceEvidence['readPreferenceRows']>>
	try {
		;[drovrStops, events, rows] = await Promise.all([
			deps.readDrovrStops(subscriber.id),
			deps.readContactEvents(subscriber.contactId),
			deps.readPreferenceRows(subscriber.email_address),
		])
	} catch {
		return allUnknown()
	}

	const stoppedEverything = drovrStops.length > 0
	// A fresh double opt-in lifts every scope (contact-stop-rule.ts).
	const lifts: ContactStopSignal[] = events
		.filter((event) => event.eventType === CONTACT_RESUBSCRIBED_EVENT_TYPE)
		.map((event) => ({ kind: 'resubscribed', at: event.occurredAt }))

	return Object.fromEntries(
		emailPreferenceDefinitions.map((preference) => {
			if (stoppedEverything) {
				return [
					preference.key,
					{ known: true, subscribed: false, stoppedEverything: true },
				]
			}
			const optOuts: ContactStopSignal[] = events
				.filter(
					(event) =>
						event.eventType === CONTACT_UNSUBSCRIBED_EVENT_TYPE &&
						event.providerReference ===
							`kit:email-preference:${preference.key}`,
				)
				.map((event) => ({ kind: 'unsubscribed', at: event.occurredAt }))
			const row = rows.get(preference.localPreferenceTypeName)
			// The row is the reader's own latest choice on this page. A stop wins
			// a tie with it, like every other lift.
			const rowSignal: ContactStopSignal[] = row
				? [
						{
							kind: row.active ? 'resubscribed' : 'unsubscribed',
							at: row.updatedAt,
						},
					]
				: []
			const stopped = activeContactStops([
				...optOuts,
				...lifts,
				...rowSignal,
			]).unsubscribed
			return [
				preference.key,
				{ known: true, subscribed: !stopped, stoppedEverything: false },
			]
		}),
	) as LocalEmailPreferences
}
