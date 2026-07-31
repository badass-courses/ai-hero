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
 * Cookie first. It carries the real Kit subscriber record, and enroling against
 * a stale session address for someone who has since changed their Kit email
 * would split them into two subscribers.
 *
 * The address comes off the server-side session and is NEVER taken from caller
 * input, so this cannot be used to enrol somebody else.
 */
export async function resolveEnrolmentIdentity(): Promise<{
	identity: EnrolmentIdentity | null
	/** The cookie record when there was one — callers still log its id. */
	subscriber: Awaited<ReturnType<typeof getSubscriberFromCookie>> | null
}> {
	const subscriber = await getSubscriberFromCookie().catch(() => null)

	if (subscriber?.email_address) {
		return {
			identity: {
				email: subscriber.email_address,
				name: subscriber.first_name ?? undefined,
				via: 'cookie',
			},
			subscriber,
		}
	}

	const auth = await getServerAuthSession().catch(() => null)
	const email = auth?.session?.user?.email
	if (!email) return { identity: null, subscriber }

	return {
		identity: {
			email,
			name: auth?.session?.user?.name ?? undefined,
			via: 'session',
		},
		subscriber,
	}
}
