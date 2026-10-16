/**
 * Who is looking at a post-purchase page, relative to the purchase.
 *
 * - `anonymous`: nobody is signed in.
 * - `owner`: the signed-in account owns the purchase.
 * - `different-account`: someone else's account is signed in. They get the
 *   generic state and never the purchase's details.
 * - `not-found`: no such purchase.
 */
export type PurchaseViewerState =
	| 'anonymous'
	| 'owner'
	| 'different-account'
	| 'not-found'

export function purchaseViewerState({
	viewerUserId,
	purchaseExists,
	purchaseOwnerId,
}: {
	viewerUserId: string | null | undefined
	purchaseExists: boolean
	purchaseOwnerId: string | null | undefined
}): PurchaseViewerState {
	if (!viewerUserId) return 'anonymous'
	if (!purchaseExists) return 'not-found'
	return purchaseOwnerId === viewerUserId ? 'owner' : 'different-account'
}

/**
 * `/thanks/purchase` is reached by checkout session, so a signed-out buyer
 * must still see their receipt. A signed-in viewer who is not the owner must
 * not: the details include the buyer's email and the team invite link.
 */
export type ThanksViewerState = 'owner' | 'anonymous' | 'different-account'

export function thanksViewerState({
	viewerUserId,
	isOwner,
}: {
	viewerUserId: string | null | undefined
	isOwner: boolean
}): ThanksViewerState {
	if (isOwner) return 'owner'
	return viewerUserId ? 'different-account' : 'anonymous'
}

/** `jo***@example.com`: enough to recognise an account, not to copy it. */
export function maskEmail(email: string | null | undefined): string {
	if (!email) return 'another account'
	const at = email.lastIndexOf('@')
	if (at < 1) return 'another account'
	const local = email.slice(0, at)
	const domain = email.slice(at + 1)
	const visible = local.length > 2 ? 2 : 1
	return `${local.slice(0, visible)}***@${domain}`
}

export function differentAccountCopy(viewerEmail: string | null | undefined) {
	return {
		title: 'This purchase belongs to a different account',
		description: `You're signed in as ${maskEmail(viewerEmail)}. Sign in with the account that made the purchase.`,
	}
}
