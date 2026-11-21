import { cookies } from 'next/headers'
import { verifyKitPreferenceLinkLocally } from '@/lib/email-preferences'

/**
 * Who a reader is, when they arrived from an email link, proven by the link.
 *
 * Kit links carry `ck_subscriber_id` and `sh_kit`, the sha256 of the
 * subscriber's email. Only a matching pair resolves. A bare subscriber id,
 * from the URL or the `ck_subscriber_id` cookie anyone can set, never returns
 * an address (security desk, 2026-11-20).
 *
 * The survey strips `ck_subscriber_id` from the URL once it has set the
 * cookie, but leaves `sh_kit`, so the id falls back to that cookie.
 */
export async function readVerifiedLinkSubscriber({
	subscriberId,
	shKit,
	route,
}: {
	subscriberId?: string | number
	shKit?: string
	route: string
}) {
	if (!shKit?.trim()) return null
	let id = subscriberId === undefined ? '' : String(subscriberId).trim()
	if (!id) {
		const cookieStore = await cookies()
		id = normalizeSubscriberIdCookie(cookieStore.get('ck_subscriber_id')?.value)
	}
	if (!id) return null
	const verification = await verifyKitPreferenceLinkLocally({
		subscriberId: id,
		shKit,
		source: 'survey-link',
		route,
	})
	return verification.status === 'verified' ? verification.subscriber : null
}

/** The cookie holds either a bare id or a JSON-encoded one. */
export function normalizeSubscriberIdCookie(value?: string) {
	return (value ?? '')
		.trim()
		.replace(/^"(.*)"$/, '$1')
		.trim()
}
