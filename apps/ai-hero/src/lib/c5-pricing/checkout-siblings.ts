import type Stripe from 'stripe'

/**
 * Creating a C5 Checkout Session expires the buyer's other open C5 sessions,
 * so at most one decision is payable at a time.
 *
 * Only sessions created before the new one go: ordered by `created`, then by
 * id. Two checkouts that race each expire only the older, so exactly the
 * newest stays open and neither expires the other's replacement. A sibling
 * paid before it could be expired stays paid; the post-payment duplicate
 * check flags it, and fulfillment never refuses it.
 */
export type CheckoutSessionReads = {
	retrieve(id: string): Promise<Pick<Stripe.Checkout.Session, 'id' | 'created'>>
	listOpen(
		customerId: string,
	): Promise<
		readonly Pick<
			Stripe.Checkout.Session,
			'id' | 'created' | 'metadata' | 'status'
		>[]
	>
	expire(id: string): Promise<unknown>
}

export type SiblingExpiry = {
	readonly expired: readonly string[]
	readonly failed: readonly string[]
}

const olderThan = (
	session: { id: string; created: number },
	kept: { id: string; created: number },
) =>
	session.created < kept.created ||
	(session.created === kept.created && session.id < kept.id)

export async function expireOlderOpenSiblings({
	sessions,
	customerIds,
	userId,
	productId,
	keepSessionId,
}: {
	sessions: CheckoutSessionReads
	customerIds: readonly string[]
	userId: string
	productId: string
	keepSessionId: string
}): Promise<SiblingExpiry> {
	const kept = await sessions.retrieve(keepSessionId)
	const expired: string[] = []
	const failed: string[] = []
	for (const customerId of new Set(customerIds)) {
		for (const session of await sessions.listOpen(customerId)) {
			if (
				session.id === kept.id ||
				session.status !== 'open' ||
				session.metadata?.productId !== productId ||
				session.metadata?.userId !== userId ||
				!olderThan(session, kept)
			)
				continue
			try {
				await sessions.expire(session.id)
				expired.push(session.id)
			} catch {
				// Already completed or expired between the list and the call. A
				// paid sibling is the duplicate check's to flag.
				failed.push(session.id)
			}
		}
	}
	return { expired, failed }
}

/** The Checkout Session id inside a Stripe-hosted checkout URL. */
export function checkoutSessionIdFromUrl(url: string | null | undefined) {
	if (!url) return null
	try {
		const parsed = new URL(url)
		if (parsed.hostname !== 'checkout.stripe.com') return null
		return (
			parsed.pathname.match(/\/(cs_(?:test|live)_[A-Za-z0-9]+)/)?.[1] ?? null
		)
	} catch {
		return null
	}
}

/**
 * Course Builder answers a checkout with a redirect: straight to Stripe, or
 * for a cohort through `/subscribe/verify-login?checkoutUrl=…`. Either way the
 * new session's id is in it.
 */
export function createdCheckoutSessionId(response: Response) {
	const location = response.headers.get('location')
	if (!location) return null
	const direct = checkoutSessionIdFromUrl(location)
	if (direct) return direct
	try {
		return checkoutSessionIdFromUrl(
			new URL(location, 'https://app.invalid').searchParams.get('checkoutUrl'),
		)
	} catch {
		return null
	}
}
