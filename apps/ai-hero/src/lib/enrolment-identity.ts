import 'server-only'

import { getSubscriberFromCookie } from '@/lib/convertkit'
import { getServerAuthSession } from '@/server/auth'

export type EnrolmentIdentity = {
	email: string
	name?: string
	/** Which source answered. Log it — the two fail for different reasons. */
	via: 'cookie' | 'session'
}

/**
 * Who to enrol, for any one-click ask (course, waitlist, interest).
 *
 * A SIGNED-IN reader is identified. They logged in from a link sent to that
 * address, which is stronger evidence than an address typed into a form — so
 * showing them a name-and-email field asks a known person to prove something
 * they have already proved. Every CTA that collects an email has this bug until
 * it uses this.
 *
 * Keep the Kit record when cookie and session agree (or there is no session).
 * A Kit-side email change can leave a stale session and risk splitting a Kit
 * subscriber, but an account email change can equally leave a stale cookie.
 * When they disagree, login proves the session address, so the session wins.
 *
 * The address comes off the server-side session and is NEVER taken from caller
 * input, so this cannot be used to enrol somebody else.
 */
export async function resolveEnrolmentIdentity(): Promise<{
	identity: EnrolmentIdentity | null
	/** Only a cookie record for this identity; safe for caller fallbacks/writes. */
	subscriber: Awaited<ReturnType<typeof getSubscriberFromCookie>> | null
}> {
	const subscriber = await getSubscriberFromCookie().catch(() => null)
	const auth = await getServerAuthSession().catch(() => null)
	const email = auth?.session?.user?.email
	const cookieMatchesSession =
		!email ||
		subscriber?.email_address?.trim().toLowerCase() ===
			email.trim().toLowerCase()

	if (subscriber?.email_address && cookieMatchesSession) {
		return {
			identity: {
				email: subscriber.email_address,
				name: subscriber.first_name ?? undefined,
				via: 'cookie',
			},
			subscriber,
		}
	}

	if (!email) return { identity: null, subscriber }

	return {
		identity: {
			email,
			name: auth?.session?.user?.name ?? undefined,
			via: 'session',
		},
		// Never let a caller fall back to, refresh, or enqueue the old Kit record
		// under the session address. A provider response can refresh it instead.
		subscriber: null,
	}
}

/**
 * True when the reader is signed in as this identity's address: they proved
 * it by logging in. A Kit cookie alone proves nothing.
 */
export async function isSignedInAs(identity: {
	email: string
	via: string
}): Promise<boolean> {
	if (identity.via === 'session') return true
	const auth = await getServerAuthSession().catch(() => null)
	const sessionEmail = auth?.session?.user?.email?.trim().toLowerCase()
	return Boolean(
		sessionEmail && sessionEmail === identity.email.trim().toLowerCase(),
	)
}
