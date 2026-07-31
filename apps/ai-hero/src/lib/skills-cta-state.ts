import 'server-only'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie } from '@/lib/convertkit'

/**
 * Which skills-course ask a reader should see. ONE resolver, because the two
 * surfaces that make this offer used to answer it differently:
 *
 * - The inline CTA derived it client-side from the Kit cookie alone, so a
 *   signed-in reader with no cookie fell through to a name-and-email form —
 *   asking a known person for an address the server already had.
 * - `/skills/subscribe` collapsed it to `subscribed` vs `show-form`, with no
 *   `tag-me` at all, so an AI Hero subscriber who had never joined the course
 *   was told they were already on it.
 *
 * Same reader, same offer, two different answers. This is the single place that
 * decides, so they cannot drift again.
 */
export type SkillsCtaState =
	/** Nobody we know. Ask for an address. */
	| 'fresh'
	/** On the AI Hero list, not the course. One click, and we may say so. */
	| 'tag-me'
	/** Signed in, unknown to Kit. One click, but do NOT claim they subscribed. */
	| 'account'
	/** Already taking the course. Make no ask. */
	| 'subscribed'

/** What a Kit record means, so no caller re-derives it. */
function fromRecord(
	record: { state?: string | null; fields?: any } | null | undefined,
): SkillsCtaState | null {
	if (record?.state !== 'active') return null
	return record.fields?.interest === 'skills' ? 'subscribed' : 'tag-me'
}

/**
 * @param sessionEmail the SIGNED-IN reader's address, or undefined. Never take
 * this from client input: it decides who gets enrolled.
 */
export async function resolveSkillsCtaState(
	sessionEmail?: string | null,
): Promise<SkillsCtaState> {
	// Cookie first. It already holds the full record, so it costs a parse rather
	// than a Kit round trip, and it is the identity the enrolment action prefers
	// for the same reason.
	const fromCookie = fromRecord(
		await getSubscriberFromCookie().catch(() => null),
	)
	if (fromCookie) return fromCookie

	if (!sessionEmail) return 'fresh'

	// Signed in with no usable cookie: ask Kit who they are rather than falling
	// through to a form. This is the case that left an enrolled reader being
	// nagged to sign up for a course they were already taking.
	const fromKit = fromRecord(
		(await emailListProvider
			.getSubscriberByEmail(sessionEmail)
			.catch(() => null)) as any,
	)
	if (fromKit) return fromKit

	// Known by account, on no list. Still one click — we have their address.
	return 'account'
}
