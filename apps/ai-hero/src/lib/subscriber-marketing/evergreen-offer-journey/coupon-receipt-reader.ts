import { Effect } from 'effect'
import { z } from 'zod'
import {
	decodeIssue,
	entitlementId,
	readCouponEvidence,
	semanticCouponId,
	type CommerceCouponRow,
	type CommerceEntitlementRow,
} from './coupon-authority'
import type { BindCouponIntent, IssueCouponIntent } from './domain'
import type { CouponBindingReceipt, CouponIssueReceipt } from './ports'
import {
	couponBindingIntentKey,
	couponIntentKey,
	type IsoInstant,
} from './primitives'

/** Separate capability: no transaction, locks, inserts, updates, or grants. */
export interface CouponReceiptReadStore {
	readonly getCoupon: (id: string) => Promise<CommerceCouponRow | null>
	readonly getCreditTypeId: () => Promise<string | null>
	readonly listCouponEntitlements: (
		couponId: string,
	) => Promise<CommerceEntitlementRow[]>
}
export type CouponReceiptInspection<Receipt> =
	| { readonly type: 'Unknown'; readonly reason: string }
	| {
			readonly type: 'Recorded'
			readonly historicalOnly: true
			readonly receipt: Receipt
			readonly operationObservedAt:
				| { readonly type: 'Known'; readonly at: IsoInstant }
				| { readonly type: 'Unknown' }
			/** Observed row state only; never a usable/authorized flag. */
			readonly current: {
				readonly couponStatus: number
				readonly usedCount: number
				readonly expiresAt: IsoInstant
				readonly grantDeletedAt?: string | null
			}
	  }
const grantMetadataSchema = z.object({
	evergreenOffer: z.object({
		journeyId: z.string(),
		contactId: z.string(),
		intentKey: z.string(),
		sourceReference: z.string(),
	}),
})

/** Recover committed historical evidence. Unknown is never permission to retry a write. */
export function createCouponReceiptReader(input: CouponReceiptReadStore) {
	const store = { ...input }
	const inspect = <A>(work: () => Promise<CouponReceiptInspection<A>>) =>
		Effect.tryPromise({
			try: work,
			catch: () => 'unavailable-or-conflicting-evidence',
		}).pipe(
			Effect.catchAll((reason) =>
				Effect.succeed({ type: 'Unknown', reason } as const),
			),
		)
	const recorded = <A>(
		row: CommerceCouponRow,
		evidence: ReturnType<typeof readCouponEvidence>,
		receipt: A,
		grantDeletedAt?: string | null,
	): CouponReceiptInspection<A> => ({
		type: 'Recorded',
		historicalOnly: true,
		receipt,
		operationObservedAt:
			evidence.operationObservedAt === undefined
				? { type: 'Unknown' }
				: { type: 'Known', at: evidence.operationObservedAt },
		current: {
			couponStatus: row.status,
			usedCount: row.usedCount,
			expiresAt: evidence.coupon.expiresAt,
			...(grantDeletedAt === undefined ? {} : { grantDeletedAt }),
		},
	})
	return {
		inspectIssue: (
			intent: IssueCouponIntent,
		): Effect.Effect<CouponReceiptInspection<CouponIssueReceipt>> =>
			inspect(async () => {
				const expected = decodeIssue(intent)
				const row = await store.getCoupon(
					semanticCouponId(expected.idempotencyKey),
				)
				if (!row) return { type: 'Unknown', reason: 'issue-evidence-missing' }
				const evidence = readCouponEvidence(row)
				if (JSON.stringify(evidence.issue) !== JSON.stringify(expected))
					return { type: 'Unknown', reason: 'issue-evidence-conflict' }
				// This is the original ISSUE receipt, not a projection of later binding state.
				return recorded(row, evidence, {
					coupon: {
						...evidence.coupon,
						binding: { type: 'AwaitingVerifiedUser' },
					},
					providerReceiptId: `commerce-coupon:${row.id}`,
				})
			}),
		inspectBinding: (
			intent: BindCouponIntent,
		): Effect.Effect<CouponReceiptInspection<CouponBindingReceipt>> =>
			inspect(async () => {
				if (
					intent.idempotencyKey !==
						couponBindingIntentKey({
							journeyId: intent.journeyId,
							verifiedUserId: intent.verifiedUserId,
						}) ||
					intent.couponId !==
						semanticCouponId(couponIntentKey(intent.journeyId))
				)
					return { type: 'Unknown', reason: 'binding-identity-conflict' }
				const row = await store.getCoupon(intent.couponId)
				if (!row) return { type: 'Unknown', reason: 'binding-coupon-missing' }
				const evidence = readCouponEvidence(row)
				const binding = evidence.binding
				const id = entitlementId(row.id)
				if (
					evidence.issue.contactId !== intent.contactId ||
					evidence.issue.journeyId !== intent.journeyId ||
					binding.type !== 'BoundToVerifiedUser' ||
					binding.verifiedUserId !== intent.verifiedUserId ||
					binding.intentKey !== intent.idempotencyKey ||
					binding.entitlementId !== id ||
					Date.parse(binding.boundAt) <
						Date.parse(
							evidence.operationObservedAt ?? evidence.issue.issueAt,
						) ||
					Date.parse(binding.boundAt) >= Date.parse(evidence.issue.expiresAt)
				)
					return { type: 'Unknown', reason: 'binding-evidence-conflict' }
				const creditTypeId = await store.getCreditTypeId()
				const grants = await store.listCouponEntitlements(row.id)
				const grant = grants[0]
				if (
					!creditTypeId ||
					grants.length !== 1 ||
					!grant ||
					grant.id !== id ||
					grant.userId !== intent.verifiedUserId ||
					grant.sourceId !== row.id ||
					grant.sourceType !== 'COUPON' ||
					grant.entitlementType !== creditTypeId ||
					grant.organizationId !== null ||
					grant.organizationMembershipId !== null ||
					grant.expiresAt?.toISOString() !== evidence.coupon.expiresAt ||
					grant.createdAt.toISOString() !== binding.boundAt
				)
					return {
						type: 'Unknown',
						reason: 'binding-grant-missing-or-conflicting',
					}
				const metadata = grantMetadataSchema.safeParse(grant.metadata)
				if (
					!metadata.success ||
					metadata.data.evergreenOffer.contactId !== intent.contactId ||
					metadata.data.evergreenOffer.journeyId !== intent.journeyId ||
					metadata.data.evergreenOffer.intentKey !== intent.idempotencyKey ||
					metadata.data.evergreenOffer.sourceReference !==
						binding.sourceReference
				)
					return {
						type: 'Unknown',
						reason: 'binding-grant-provenance-conflict',
					}
				// deletedAt and current coupon validity are deliberately not historical validity gates.
				return recorded(
					row,
					evidence,
					{
						coupon: evidence.coupon,
						providerReceiptId: `commerce-entitlement:${id}`,
					},
					grant.deletedAt?.toISOString() ?? null,
				)
			}),
	}
}
