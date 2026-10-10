import { CB_AUTHORITATIVE_PRICING_CONTRACT_VERSION } from '@coursebuilder/core/schemas'

import { C5_PRODUCT_ID, decodeDecisionRef } from './decision'

/**
 * The saved decision is the C5 credit ledger. Each paid C5 purchase keeps
 * the decision its checkout charged, under
 * `Purchase.fields.c5Decision`. A credit is spent when some C5 purchase's
 * saved decision names it as its `creditSource`; nothing else records it.
 *
 * It is written after the purchase exists, from the Checkout Session's raw
 * metadata: `PurchaseMetadata.parse` drops the version fields, so the parsed
 * purchase info cannot be used. The webhook and the checkout reconciler both
 * run the same core handler, which sends `new-purchase-created`, so a
 * reconciler-fulfilled purchase gets its decision the same way.
 */
export const C5_DECISION_FIELD = 'c5Decision'
/** Set by the post-payment duplicate check, beside the decision. */
export const C5_DUPLICATE_FIELD = 'c5DuplicateOf'

export type SavedC5Decision = {
	readonly v: 1
	readonly decisionRef: string
	readonly creditSource: string | null
	readonly contract: string
	readonly engineVersion: string
	readonly policyVersion: string
	readonly accessRestriction: 'none' | 'region'
	readonly expectedTotalCents: number | null
	readonly checkoutSessionId: string
	readonly savedAt: string
}

/** A stored field is only trusted when it has the saved shape. */
export function parseSavedDecision(value: unknown): SavedC5Decision | null {
	if (!value || typeof value !== 'object') return null
	const row = value as Record<string, unknown>
	if (
		row.v !== 1 ||
		typeof row.decisionRef !== 'string' ||
		!(row.creditSource === null || typeof row.creditSource === 'string') ||
		typeof row.engineVersion !== 'string' ||
		typeof row.policyVersion !== 'string' ||
		typeof row.checkoutSessionId !== 'string'
	)
		return null
	return row as unknown as SavedC5Decision
}

export type RawCheckoutSession = {
	readonly id: string
	readonly metadata: Record<string, string> | null
}

/**
 * Reads the decision a C5 checkout charged from its raw session metadata.
 * Null for any session the authoritative hook did not price: another
 * product, or a legacy-contract session.
 */
export function decisionFromSession(
	session: RawCheckoutSession,
	savedAt: Date,
): SavedC5Decision | null {
	const metadata = session.metadata ?? {}
	if (metadata.productId !== C5_PRODUCT_ID) return null
	if (metadata.cbPricingContract !== CB_AUTHORITATIVE_PRICING_CONTRACT_VERSION)
		return null
	const { decisionRef, engineVersion, policyVersion } = metadata
	if (!decisionRef || !engineVersion || !policyVersion) return null
	const ref = decodeDecisionRef(decisionRef)
	if (!ref) return null
	const expected = Number(metadata.expectedTotalCents)
	return {
		v: 1,
		decisionRef,
		creditSource: ref.creditSource,
		contract: metadata.cbPricingContract,
		engineVersion,
		policyVersion,
		accessRestriction:
			metadata.accessRestriction === 'region' ? 'region' : 'none',
		expectedTotalCents: Number.isSafeInteger(expected) ? expected : null,
		checkoutSessionId: session.id,
		savedAt: savedAt.toISOString(),
	}
}

export type C5PurchaseRow = {
	readonly id: string
	readonly userId: string | null
	readonly productId: string
	readonly status: string
	readonly bulkCouponId: string | null
	readonly redeemedBulkCouponId: string | null
	readonly decision: SavedC5Decision | null
}

export interface C5DecisionStore {
	purchase(purchaseId: string): Promise<C5PurchaseRow | null>
	/** Idempotent: writes the decision field only, leaving other fields alone. */
	saveDecision(purchaseId: string, decision: SavedC5Decision): Promise<void>
	markDuplicate(
		purchaseId: string,
		duplicateOf: readonly string[],
	): Promise<void>
	/** The buyer's current individual C5 purchases. */
	individualPurchases(userId: string): Promise<readonly C5PurchaseRow[]>
	/** Every C5 purchase, any owner or status, whose decision spent this credit. */
	spentBy(creditSource: string): Promise<readonly string[]>
}

const CURRENT = new Set(['Valid', 'Restricted'])
const isIndividual = (row: C5PurchaseRow) =>
	!row.bulkCouponId && !row.redeemedBulkCouponId

export type DuplicateVerdict =
	| { readonly kind: 'clean' }
	| {
			readonly kind: 'duplicate'
			/** Other purchases this one duplicates. */
			readonly duplicateOf: readonly string[]
			readonly reasons: readonly (
				| 'second-individual-c5'
				| 'credit-spent-twice'
			)[]
	  }

/**
 * The post-payment duplicate check. A second individual C5 purchase for one
 * buyer, or a second purchase spending the same credit, is flagged for a
 * refund. It counts every purchase, however it was fulfilled (webhook or
 * reconciler). It never refuses or reverses fulfillment.
 */
export async function checkC5Duplicate(
	store: C5DecisionStore,
	purchase: C5PurchaseRow,
): Promise<DuplicateVerdict> {
	if (!isIndividual(purchase)) return { kind: 'clean' }
	const reasons: ('second-individual-c5' | 'credit-spent-twice')[] = []
	const others = new Set<string>()
	if (purchase.userId) {
		const owned = (await store.individualPurchases(purchase.userId)).filter(
			(row) =>
				row.id !== purchase.id && CURRENT.has(row.status) && isIndividual(row),
		)
		if (owned.length) {
			reasons.push('second-individual-c5')
			for (const row of owned) others.add(row.id)
		}
	}
	const credit = purchase.decision?.creditSource
	if (credit) {
		const spent = (await store.spentBy(credit)).filter(
			(id) => id !== purchase.id,
		)
		if (spent.length) {
			reasons.push('credit-spent-twice')
			for (const id of spent) others.add(id)
		}
	}
	return reasons.length
		? { kind: 'duplicate', duplicateOf: [...others].sort(), reasons }
		: { kind: 'clean' }
}

export type RecordC5DecisionResult =
	| { readonly status: 'not-c5' | 'missing-purchase' }
	| {
			readonly status: 'saved' | 'legacy'
			readonly purchaseId: string
			readonly verdict: DuplicateVerdict
	  }

/**
 * Saves the decision for one new C5 purchase, then runs the duplicate check.
 * `legacy` means the session carried no decision (a pre-hook session); it is
 * still checked for duplicates.
 */
export async function recordC5PurchaseDecision({
	purchaseId,
	store,
	getCheckoutSession,
	checkoutSessionId,
	now,
}: {
	purchaseId: string
	store: C5DecisionStore
	getCheckoutSession: (id: string) => Promise<RawCheckoutSession>
	checkoutSessionId: string | null
	now: () => Date
}): Promise<RecordC5DecisionResult> {
	const purchase = await store.purchase(purchaseId)
	if (!purchase) return { status: 'missing-purchase' }
	if (purchase.productId !== C5_PRODUCT_ID) return { status: 'not-c5' }
	let decision = purchase.decision
	if (!decision && checkoutSessionId) {
		const session = await getCheckoutSession(checkoutSessionId)
		decision = decisionFromSession(session, now())
		if (decision) await store.saveDecision(purchaseId, decision)
	}
	const verdict = await checkC5Duplicate(store, { ...purchase, decision })
	if (verdict.kind === 'duplicate')
		await store.markDuplicate(purchaseId, verdict.duplicateOf)
	return {
		status: decision ? 'saved' : 'legacy',
		purchaseId,
		verdict,
	}
}
