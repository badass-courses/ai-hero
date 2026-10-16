/**
 * What happens when someone opens a transfer acceptance email's one-time login
 * link. The first click signs the recipient in. A second click finds the token
 * spent, which is not the same as the transfer being over: the transfer page
 * knows the truth, so a spent link goes there instead of to an expiry error.
 *
 * Copy and routing only. Token lifetimes and sign-in are untouched, and the
 * accept button is offered only to the signed-in recipient.
 */

export type AcceptanceTokenState = 'valid' | 'spent'

/** `recipient` is the signed-in account whose email is the transfer's target. */
export type AcceptanceViewer = 'signed-out' | 'recipient' | 'other'

/** `unknown` is for callers that have not read the transfer yet. */
export type AcceptanceTransferState =
	'pending' | 'accepted' | 'canceled' | 'expired' | 'unknown'

export type AcceptanceLinkView = {
	/** `confirm`: use the token as usual. `transfer`: go to the transfer page. */
	route: 'confirm' | 'transfer'
	/** A line for the transfer page to show above its own state; null for none. */
	notice: string | null
	/** True only for the signed-in recipient of a pending transfer. */
	mayAccept: boolean
}

export const TRANSFER_STILL_WAITING = 'Your transfer is still waiting for you.'

export const ACCEPTANCE_TOKEN_STATES = ['valid', 'spent'] as const
export const ACCEPTANCE_VIEWERS = ['signed-out', 'recipient', 'other'] as const
export const ACCEPTANCE_TRANSFER_STATES = [
	'pending',
	'accepted',
	'canceled',
	'expired',
	'unknown',
] as const

const SPENT: Record<
	AcceptanceTransferState,
	Record<AcceptanceViewer, AcceptanceLinkView>
> = {
	pending: {
		'signed-out': {
			route: 'transfer',
			notice: TRANSFER_STILL_WAITING,
			mayAccept: false,
		},
		recipient: {
			route: 'transfer',
			notice: TRANSFER_STILL_WAITING,
			mayAccept: true,
		},
		// Someone else's account never sees the accept button; the page asks
		// them to sign in as the recipient.
		other: { route: 'transfer', notice: null, mayAccept: false },
	},
	accepted: {
		'signed-out': { route: 'transfer', notice: null, mayAccept: false },
		recipient: { route: 'transfer', notice: null, mayAccept: false },
		other: { route: 'transfer', notice: null, mayAccept: false },
	},
	canceled: {
		'signed-out': { route: 'transfer', notice: null, mayAccept: false },
		recipient: { route: 'transfer', notice: null, mayAccept: false },
		other: { route: 'transfer', notice: null, mayAccept: false },
	},
	expired: {
		'signed-out': { route: 'transfer', notice: null, mayAccept: false },
		recipient: { route: 'transfer', notice: null, mayAccept: false },
		other: { route: 'transfer', notice: null, mayAccept: false },
	},
	// Not read yet: the transfer page decides and says so honestly.
	unknown: {
		'signed-out': { route: 'transfer', notice: null, mayAccept: false },
		recipient: { route: 'transfer', notice: null, mayAccept: false },
		other: { route: 'transfer', notice: null, mayAccept: false },
	},
}

export function acceptanceLinkView({
	tokenState,
	signedIn,
	transferState,
}: {
	tokenState: AcceptanceTokenState
	signedIn: AcceptanceViewer
	transferState: AcceptanceTransferState
}): AcceptanceLinkView {
	if (tokenState === 'valid') {
		return {
			route: 'confirm',
			notice: null,
			mayAccept: signedIn === 'recipient' && transferState === 'pending',
		}
	}
	return SPENT[transferState][signedIn]
}

/** `transfer/<id>` paths only; anything else is not an acceptance link. */
export function transferPathOf(path: string): string | null {
	return /^\/transfer\/[A-Za-z0-9_-]+$/.test(path) ? path : null
}

/** `pat@home.example` -> `p**@home.example`. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf('@')
	if (at < 1) return '***'
	return `${email[0]}**${email.slice(at)}`
}
