/**
 * The per-purchase dispute lifecycle as a typed transition table. Pure: no
 * database, no clock, no Discord. `purchase-disputes.ts` applies a decision
 * under a row lock; this file decides what is legal.
 *
 *   none ──opened──▶ open ──won──▶ won   (restore what the cut recorded)
 *     │               └───lost──▶ lost  (keep the cut, block the buyer)
 *     ├──won──▶ won   (nothing was cut; a late `opened` is now ignored)
 *     └──lost─▶ lost  (cut now, block the buyer)
 *
 * `won` and `lost` are terminal. A refund overrides every state: once seen it
 * is recorded as `refundedAt` and the purchase stays `Refunded` with no
 * restoration, even if a replayed event overwrites the status later.
 *
 * Every event, including a `reconcile` with no Stripe meaning, also repairs
 * the purchase status to the one the record implies, so a late or duplicate
 * commerce write cannot leave a won purchase `Disputed`.
 *
 * The record's `stripeDisputeId` and `state` (and `refundedAt`) are the
 * contract `@coursebuilder/commerce/dispute-lifecycle` reads to guard its own
 * status writers.
 */

export const DISPUTE_STATES = ['open', 'won', 'lost'] as const
export type DisputeState = (typeof DISPUTE_STATES)[number]
export type DisputeEventType = 'opened' | 'won' | 'lost' | 'reconcile'

export const ACCESS_STATUSES = ['Valid', 'Restricted'] as const
export type AccessStatus = (typeof ACCESS_STATUSES)[number]
export type PurchaseStatus =
	| AccessStatus
	| 'Disputed'
	| 'Refunded'
	| 'Banned'
	| (string & {})

export const isAccessStatus = (status: unknown): status is AccessStatus =>
	ACCESS_STATUSES.includes(status as AccessStatus)

export type DiscordRoleSyncResult =
	/** The dispute took the role off the user. A win puts it back. */
	| 'removed'
	/** The user did not hold the role when it should have gone. */
	| 'absent'
	/** Another live grant still gives the user this role; left alone. */
	| 'kept'
	/** A role this dispute removed was put back. */
	| 'restored'
	/** The user has no Discord account or is not in the guild. */
	| 'no-account'

export type BuyerBlockOutcome =
	| { status: 'blocked'; userId: string; alreadyBlocked: boolean }
	/** The paying buyer could not be proven, so nobody was blocked. */
	| { status: 'held'; reason: string }

export type PurchaseDisputeRecord = {
	stripeDisputeId: string
	state: DisputeState
	/**
	 * The status the dispute interrupted, persisted before any write. `null`
	 * when it could not be known; a win then restores access but holds the
	 * status for an operator instead of guessing.
	 */
	originalStatus: AccessStatus | null
	openedAt: string
	closedAt?: string
	/** Sticky refund override; see the module comment. */
	refundedAt?: string
	/** Entitlement rows this dispute soft-deleted, purchase rows and credits. */
	revokedEntitlementIds: string[]
	/** Discord roles granted by the revoked rows. */
	discordRoleIds: string[]
	/** What happened to each role in Discord, separate from the rows. */
	discordSync: Record<
		string,
		{
			result: DiscordRoleSyncResult
			at: string
			/** Discord accepted the change but the readback could not run. */
			unverified?: true
		}
	>
	buyer?: BuyerBlockOutcome
}

export type DisputeDecision =
	| {
			kind: 'ignored'
			reason: string
	  }
	| {
			/** applied: state moved; repaired: only status/refund fixed; unchanged: nothing to do. */
			kind: 'applied' | 'repaired' | 'unchanged'
			/** Set when the event conflicts with a terminal state but repairs still ran. */
			reason?: string
			createRecord: boolean
			from: DisputeState | null
			to: DisputeState
			originalStatus: AccessStatus | null
			/** Soft-delete the purchase's live rows and unused credits now. */
			cut: boolean
			/** Undelete the rows the record says this dispute cut. */
			restore: boolean
			/** New purchase status, or null to leave it. */
			status: PurchaseStatus | null
			/** Why a status the record implies was not written. */
			statusHeld?: 'original-status-unknown'
			blockBuyer: boolean
			markRefunded: boolean
	  }

/** The status a purchase should hold for a dispute state. */
function impliedStatus(
	state: DisputeState,
	originalStatus: AccessStatus | null,
	refunded: boolean,
): PurchaseStatus | null {
	if (refunded) return 'Refunded'
	if (state === 'won') return originalStatus
	return 'Disputed'
}

/**
 * The status the dispute interrupted: the purchase's own status when it still
 * grants access, else what commerce read before writing `Disputed`. Never a
 * default.
 */
export function resolveOriginalStatus(
	purchaseStatus: PurchaseStatus,
	eventPreviousStatus?: string,
): AccessStatus | null {
	if (isAccessStatus(purchaseStatus)) return purchaseStatus
	if (isAccessStatus(eventPreviousStatus)) return eventPreviousStatus
	return null
}

export function decideDisputeTransition({
	record,
	event,
	stripeDisputeId,
	purchaseStatus,
	eventPreviousStatus,
}: {
	record: PurchaseDisputeRecord | undefined
	event: DisputeEventType
	stripeDisputeId: string
	purchaseStatus: PurchaseStatus
	eventPreviousStatus?: string
}): DisputeDecision {
	if (record && record.stripeDisputeId !== stripeDisputeId)
		return { kind: 'ignored', reason: 'different-dispute' }

	const refunded = purchaseStatus === 'Refunded' || Boolean(record?.refundedAt)

	if (!record) {
		if (event === 'reconcile') return { kind: 'ignored', reason: 'no-record' }
		// Banned purchases are unpaid seat redemptions and hold no access.
		if (
			!isAccessStatus(purchaseStatus) &&
			purchaseStatus !== 'Disputed' &&
			purchaseStatus !== 'Refunded'
		)
			return { kind: 'ignored', reason: `status-${purchaseStatus}` }

		const to: DisputeState = event === 'opened' ? 'open' : event
		const originalStatus = resolveOriginalStatus(
			purchaseStatus,
			eventPreviousStatus,
		)
		const target = impliedStatus(to, originalStatus, refunded)
		return {
			kind: 'applied',
			createRecord: true,
			from: null,
			to,
			originalStatus,
			cut: !refunded && to !== 'won',
			restore: false,
			status: target && target !== purchaseStatus ? target : null,
			...(!target &&
				purchaseStatus === 'Disputed' && {
					statusHeld: 'original-status-unknown' as const,
				}),
			blockBuyer: to === 'lost',
			markRefunded: false,
		}
	}

	const from = record.state
	let to = from
	let reason: string | undefined
	if (event === 'won' || event === 'lost') {
		if (from === 'open') to = event
		else if (from !== event) reason = `closed-${from}`
	}

	const target = impliedStatus(to, record.originalStatus, refunded)
	const status = target && target !== purchaseStatus ? target : null
	const markRefunded = refunded && !record.refundedAt
	const blockBuyer = to === 'lost' && (from !== 'lost' || !record.buyer)
	const kind =
		to !== from || blockBuyer
			? 'applied'
			: status || markRefunded
				? 'repaired'
				: 'unchanged'

	return {
		kind,
		...(reason && { reason }),
		createRecord: false,
		from,
		to,
		originalStatus: record.originalStatus,
		cut: false,
		restore: from === 'open' && to === 'won' && !refunded,
		status,
		...(!target &&
			to === 'won' &&
			purchaseStatus === 'Disputed' && {
				statusHeld: 'original-status-unknown' as const,
			}),
		blockBuyer,
		markRefunded,
	}
}

export function readDisputeRecord(
	fields: unknown,
): PurchaseDisputeRecord | undefined {
	const record = (fields as { dispute?: unknown } | null | undefined)?.dispute
	if (!record || typeof record !== 'object') return undefined
	const candidate = record as Partial<PurchaseDisputeRecord>
	if (
		typeof candidate.stripeDisputeId !== 'string' ||
		!DISPUTE_STATES.includes(candidate.state as DisputeState) ||
		!(
			candidate.originalStatus === null ||
			isAccessStatus(candidate.originalStatus)
		) ||
		!Array.isArray(candidate.revokedEntitlementIds) ||
		!Array.isArray(candidate.discordRoleIds)
	)
		return undefined
	return {
		...candidate,
		discordSync: candidate.discordSync ?? {},
	} as PurchaseDisputeRecord
}
