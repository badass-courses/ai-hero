import type { TransferState } from '@/purchase-transfer/transfer-lifecycle'

import {
	acceptanceLinkView,
	type AcceptanceTransferState,
	type AcceptanceViewer,
} from './acceptance-link-view'

/** Every stored transfer state, mapped; a new state fails to compile here. */
export const ACCEPTANCE_STATE_OF_TRANSFER: Record<
	TransferState,
	AcceptanceTransferState
> = {
	AVAILABLE: 'unknown',
	INITIATED: 'pending',
	// A claim that has not moved the purchase was interrupted and resumes.
	VERIFIED: 'pending',
	CANCELED: 'canceled',
	EXPIRED: 'expired',
	// A legacy value some historical rows carry; terminal.
	CONFIRMED: 'accepted',
	COMPLETED: 'accepted',
}

export type TransferPageKind =
	| 'accepted'
	| 'canceled'
	| 'expired'
	| 'accept'
	| 'sign-in'

/**
 * What the transfer page shows, from the transfer's real state and who is
 * looking. The accept affordance and the "still waiting" notice both come from
 * `acceptanceLinkView`, so a viewer who may not accept is never offered it and
 * a finished transfer is never called pending.
 */
export function transferPageView({
	transferState,
	purchaseMoved,
	clockExpired,
	viewer,
	linkUsed,
}: {
	transferState: TransferState
	/** A VERIFIED claim whose purchase already moved to the recipient. */
	purchaseMoved: boolean
	/** An INITIATED transfer past its expiry that has not been marked yet. */
	clockExpired: boolean
	viewer: AcceptanceViewer
	linkUsed: boolean
}): { kind: TransferPageKind; notice: string | null } {
	let state = ACCEPTANCE_STATE_OF_TRANSFER[transferState]
	if (state === 'pending' && purchaseMoved) state = 'accepted'
	if (state === 'pending' && transferState === 'INITIATED' && clockExpired)
		state = 'expired'

	const link = acceptanceLinkView({
		tokenState: linkUsed ? 'spent' : 'valid',
		signedIn: viewer,
		transferState: state,
	})
	const notice = link.notice
	if (state === 'accepted') return { kind: 'accepted', notice }
	if (state === 'canceled') return { kind: 'canceled', notice }
	if (state === 'expired') return { kind: 'expired', notice }
	return { kind: link.mayAccept ? 'accept' : 'sign-in', notice }
}
