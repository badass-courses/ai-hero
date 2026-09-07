import { createHash } from 'node:crypto'
import type { coupon, entitlements, merchantCoupon, users } from '@/db/schema'
import { Effect } from 'effect'
import { z } from 'zod'

import { restoreDeadlineTimeZoneEvidence } from '../course-sequence-exhaustion'
import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
	type IssueCouponIntent,
	type IssuedCoupon,
} from './domain'
import type { CouponAuthority, EffectApplicationError } from './ports'
import {
	couponBindingIntentKey,
	couponIntentKey,
	parseContactId,
	parseCouponId,
	parseIntentKey,
	parseIsoInstant,
	parseJourneyId,
	parseVerifiedUserId,
	type ParseResult,
} from './primitives'

export type CommerceCouponRow = typeof coupon.$inferSelect
export type CommerceEntitlementRow = typeof entitlements.$inferSelect
export type CommerceMerchantCouponRow = typeof merchantCoupon.$inferSelect
export type CommerceUserRow = typeof users.$inferSelect

/** Transaction methods must all use the same connection and commit atomically. */
export interface CouponTransaction {
	readonly getMerchantCoupon: (
		id: string,
	) => Promise<CommerceMerchantCouponRow | null>
	readonly getCoupon: (id: string) => Promise<CommerceCouponRow | null>
	readonly insertCoupon: (row: CommerceCouponRow) => Promise<void>
	readonly setCouponFields: (
		id: string,
		fields: Record<string, unknown>,
	) => Promise<void>
	readonly getUser: (id: string) => Promise<CommerceUserRow | null>
	readonly getCreditTypeId: () => Promise<string | null>
	readonly listCouponEntitlements: (
		id: string,
	) => Promise<CommerceEntitlementRow[]>
	readonly insertEntitlement: (row: CommerceEntitlementRow) => Promise<void>
}
export interface CouponCommerceStore {
	/** Lock the existing contact row before invoking work; missing contact must refuse. */
	readonly withContactLock: <A>(
		contactId: string,
		work: (tx: CouponTransaction) => Promise<A>,
	) => Promise<A>
}

const termsSchema = z.object({
	productId: z.literal(EVERGREEN_OFFER_PRODUCT_ID),
	currency: z.literal(EVERGREEN_OFFER_CURRENCY),
	amountOffCents: z.literal(EVERGREEN_OFFER_AMOUNT_OFF_CENTS),
	maxUses: z.literal(EVERGREEN_OFFER_MAX_USES),
	exclusive: z.literal(true),
})
const issueSchema = z.object({
	type: z.literal('IssueCoupon'),
	idempotencyKey: z.string(),
	journeyId: z.string(),
	contactId: z.string(),
	issueAt: z.string(),
	expiresAt: z.string(),
	terms: termsSchema,
	deadlineTimeZone: z.unknown(),
})
const bindingSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('AwaitingVerifiedUser') }),
	z.object({
		type: z.literal('BoundToVerifiedUser'),
		verifiedUserId: z.string(),
		boundAt: z.string(),
		intentKey: z.string(),
		entitlementId: z.string(),
		sourceReference: z.string().min(1),
	}),
])
const metadataSchema = z.object({
	exclusive: z.literal(true),
	evergreenOffer: z.object({
		format: z.literal(1),
		issue: issueSchema,
		binding: bindingSchema,
	}),
})
const merchantEvidenceSchema = z.object({
	id: z.string().min(1),
	identifier: z.string().min(1),
	merchantAccountId: z.string().min(1),
	currency: z.literal(EVERGREEN_OFFER_CURRENCY),
	amountOffCents: z.literal(EVERGREEN_OFFER_AMOUNT_OFF_CENTS),
	type: z.literal('special'),
	sourceReference: z.string().min(1),
})
const proofSchema = z.object({
	type: z.literal('VerifiedUserObserved'),
	contactId: z.string(),
	journeyId: z.string(),
	verifiedUserId: z.string(),
	observedAt: z.string(),
	sourceReference: z.string().min(1),
})
export type VerifiedCouponOwnerQuery = {
	readonly contactId: string
	readonly journeyId: string
	readonly verifiedUserId: string
}
export type CouponAuthorityOptions = {
	readonly store: CouponCommerceStore
	/** Existing provider readback; MerchantCoupon itself has no currency column. No provider creation here. */
	readonly merchantCouponEvidence: unknown
	/** Application-owned verified identity authority. No default; email/ContactLink alone is not proof. */
	readonly readVerifiedOwner?: (
		input: VerifiedCouponOwnerQuery,
	) => Promise<unknown>
	readonly now: () => string
}

export class CouponAuthorityFailure extends Error {
	constructor(readonly failure: EffectApplicationError) {
		super(failure.reason)
	}
}
export function refuseCoupon(reason: string): never {
	throw new CouponAuthorityFailure({ type: 'EffectPermanentRefusal', reason })
}
function value<A>(parsed: ParseResult<A>): A {
	if (!parsed.ok) return refuseCoupon('invalid-coupon-primitive')
	return parsed.value
}
export function semanticCouponId(intentKey: string): string {
	return `eoj-coupon:${createHash('sha256').update(intentKey).digest('hex')}`
}
function entitlementId(couponId: string): string {
	return `eoj-credit:${createHash('sha256').update(couponId).digest('hex')}`
}
function decodeIssue(input: unknown): IssueCouponIntent {
	const parsed = issueSchema.safeParse(input)
	if (!parsed.success) return refuseCoupon('invalid-issue-intent')
	const source = parsed.data
	const zone = restoreDeadlineTimeZoneEvidence(source.deadlineTimeZone)
	if (!zone) return refuseCoupon('invalid-deadline-evidence')
	const journeyId = value(parseJourneyId(source.journeyId))
	const key = value(parseIntentKey(source.idempotencyKey))
	if (key !== couponIntentKey(journeyId))
		return refuseCoupon('wrong-issue-semantic-key')
	const issueAt = value(parseIsoInstant(source.issueAt))
	const expiresAt = value(parseIsoInstant(source.expiresAt))
	if (Date.parse(expiresAt) <= Date.parse(issueAt))
		return refuseCoupon('invalid-coupon-window')
	return {
		type: 'IssueCoupon',
		idempotencyKey: key,
		journeyId,
		contactId: value(parseContactId(source.contactId)),
		issueAt,
		expiresAt,
		terms: source.terms,
		deadlineTimeZone: zone,
	}
}
function readCoupon(row: CommerceCouponRow) {
	const parsed = metadataSchema.safeParse(row.fields)
	if (!parsed.success) return refuseCoupon('coupon-not-owned-by-journey')
	const issue = decodeIssue(parsed.data.evergreenOffer.issue)
	if (
		row.id !== semanticCouponId(issue.idempotencyKey) ||
		row.code !== null ||
		row.default !== false ||
		row.organizationId !== null ||
		row.restrictedToProductId !== issue.terms.productId ||
		row.amountDiscount !== issue.terms.amountOffCents ||
		row.percentageDiscount !== null ||
		row.maxUses !== issue.terms.maxUses ||
		row.status !== 1 ||
		row.usedCount !== 0 ||
		row.createdAt.toISOString() !== issue.issueAt ||
		row.expires?.toISOString() !== issue.expiresAt
	) {
		return refuseCoupon('coupon-state-or-terms-conflict')
	}
	const binding = parsed.data.evergreenOffer.binding
	const coupon: IssuedCoupon = {
		couponId: value(parseCouponId(row.id)),
		contactId: issue.contactId,
		issuedAt: value(parseIsoInstant(row.createdAt.toISOString())),
		expiresAt: value(parseIsoInstant(row.expires.toISOString())),
		terms: issue.terms,
		deadlineTimeZone: issue.deadlineTimeZone,
		binding:
			binding.type === 'AwaitingVerifiedUser'
				? { type: 'AwaitingVerifiedUser' }
				: {
						type: 'BoundToVerifiedUser',
						verifiedUserId: value(parseVerifiedUserId(binding.verifiedUserId)),
						boundAt: value(parseIsoInstant(binding.boundAt)),
					},
	}
	return { issue, coupon, binding }
}

/** Dormant commerce adapter. No default DB, auth reader, provider call, pricing, or runtime registration. */
export function createCouponAuthority(
	input: CouponAuthorityOptions,
): CouponAuthority {
	const options = { ...input }
	const evidence = (() => {
		try {
			return merchantEvidenceSchema.safeParse(input.merchantCouponEvidence)
		} catch {
			return { success: false } as const
		}
	})()
	const now = () => {
		try {
			return value(parseIsoInstant(options.now()))
		} catch (error) {
			if (error instanceof CouponAuthorityFailure) throw error
			throw new CouponAuthorityFailure({
				type: 'EffectTransientUnavailable',
				reason: 'clock-unavailable',
			})
		}
	}
	const checkWindow = (issuedAt: string, expiresAt: string) => {
		const at = now()
		const clock = Date.parse(at)
		if (clock < Date.parse(issuedAt) || clock >= Date.parse(expiresAt))
			refuseCoupon('outside-coupon-window')
		return at
	}
	const checkMerchant = async (tx: CouponTransaction, expectedId?: string) => {
		if (!evidence.success)
			return refuseCoupon('missing-or-invalid-merchant-evidence')
		const configured = evidence.data
		const actual = await tx.getMerchantCoupon(configured.id)
		if (
			!actual ||
			(expectedId !== undefined && expectedId !== actual.id) ||
			actual.id !== configured.id ||
			actual.status !== 1 ||
			actual.type !== 'special' ||
			actual.organizationId !== null ||
			actual.identifier !== configured.identifier ||
			actual.merchantAccountId !== configured.merchantAccountId ||
			actual.amountDiscount !== configured.amountOffCents ||
			actual.percentageDiscount !== null
		)
			return refuseCoupon('merchant-coupon-conflict')
		return actual.id
	}
	const run = <A>(work: () => Promise<A>) =>
		Effect.tryPromise({
			try: work,
			catch: (cause): EffectApplicationError =>
				cause instanceof CouponAuthorityFailure
					? cause.failure
					: {
							type: 'EffectAmbiguous',
							reason: 'commerce-transaction-unresolved',
						},
		})
	return {
		issue: (intent) =>
			run(async () => {
				const issue = decodeIssue(intent)
				return options.store.withContactLock(issue.contactId, async (tx) => {
					checkWindow(issue.issueAt, issue.expiresAt)
					const merchantCouponId = await checkMerchant(tx)
					const id = semanticCouponId(issue.idempotencyKey)
					let row = await tx.getCoupon(id)
					if (!row) {
						checkWindow(issue.issueAt, issue.expiresAt)
						row = {
							id,
							organizationId: null,
							code: null,
							createdAt: new Date(issue.issueAt),
							expires: new Date(issue.expiresAt),
							fields: {
								exclusive: true,
								evergreenOffer: {
									format: 1,
									issue,
									binding: { type: 'AwaitingVerifiedUser' },
								},
							},
							maxUses: issue.terms.maxUses,
							default: false,
							merchantCouponId,
							status: 1,
							usedCount: 0,
							percentageDiscount: null,
							amountDiscount: issue.terms.amountOffCents,
							restrictedToProductId: issue.terms.productId,
						}
						await tx.insertCoupon(row)
						row = await tx.getCoupon(id)
						if (!row) return refuseCoupon('coupon-insert-readback-missing')
					}
					const persisted = readCoupon(row)
					if (
						row.merchantCouponId !== merchantCouponId ||
						JSON.stringify(persisted.issue) !== JSON.stringify(issue)
					)
						return refuseCoupon('issue-identity-conflict')
					checkWindow(persisted.coupon.issuedAt, persisted.coupon.expiresAt)
					return {
						coupon: persisted.coupon,
						providerReceiptId: `commerce-coupon:${row.id}`,
					}
				})
			}),
		bind: (intent) =>
			run(async () => {
				const journeyId = value(parseJourneyId(intent.journeyId))
				const userId = value(parseVerifiedUserId(intent.verifiedUserId))
				if (
					intent.idempotencyKey !==
					couponBindingIntentKey({ journeyId, verifiedUserId: userId })
				)
					return refuseCoupon('wrong-bind-semantic-key')
				return options.store.withContactLock(
					value(parseContactId(intent.contactId)),
					async (tx) => {
						const row = await tx.getCoupon(intent.couponId)
						if (!row) return refuseCoupon('coupon-not-found')
						const persisted = readCoupon(row)
						if (
							persisted.issue.contactId !== intent.contactId ||
							persisted.issue.journeyId !== journeyId
						)
							return refuseCoupon('coupon-owner-conflict')
						checkWindow(persisted.coupon.issuedAt, persisted.coupon.expiresAt)
						await checkMerchant(tx, row.merchantCouponId ?? '')
						if (!options.readVerifiedOwner)
							return refuseCoupon('verified-owner-proof-required')
						let rawProof: unknown
						try {
							rawProof = await options.readVerifiedOwner({
								contactId: intent.contactId,
								journeyId,
								verifiedUserId: userId,
							})
						} catch {
							throw new CouponAuthorityFailure({
								type: 'EffectTransientUnavailable',
								reason: 'verified-owner-proof-unavailable',
							})
						}
						const proof = proofSchema.safeParse(rawProof)
						const user = await tx.getUser(userId)
						if (
							!proof.success ||
							proof.data.contactId !== intent.contactId ||
							proof.data.journeyId !== journeyId ||
							proof.data.verifiedUserId !== userId ||
							!user ||
							user.id !== userId ||
							!user.emailVerified ||
							!Number.isFinite(user.emailVerified.getTime()) ||
							user.emailVerified.getTime() > Date.parse(now())
						)
							return refuseCoupon('verified-owner-proof-mismatch')
						const observedAt = value(parseIsoInstant(proof.data.observedAt))
						if (Date.parse(observedAt) > Date.parse(now()))
							return refuseCoupon('future-verification-proof')
						const creditTypeId = await tx.getCreditTypeId()
						if (!creditTypeId)
							return refuseCoupon('credit-entitlement-type-missing')
						const existing = await tx.listCouponEntitlements(row.id)
						const id = entitlementId(row.id)
						if (persisted.binding.type === 'BoundToVerifiedUser') {
							const bound = persisted.binding
							const grant = existing[0]
							if (
								bound.verifiedUserId !== userId ||
								bound.intentKey !== intent.idempotencyKey ||
								bound.entitlementId !== id ||
								existing.length !== 1 ||
								!grant ||
								grant.id !== id ||
								grant.userId !== userId ||
								grant.entitlementType !== creditTypeId ||
								grant.sourceType !== 'COUPON' ||
								grant.sourceId !== row.id ||
								grant.organizationId !== null ||
								grant.organizationMembershipId !== null ||
								grant.deletedAt !== null ||
								grant.expiresAt?.toISOString() !== persisted.coupon.expiresAt
							)
								return refuseCoupon('existing-binding-conflict-or-revoked')
							checkWindow(persisted.coupon.issuedAt, persisted.coupon.expiresAt)
							return {
								coupon: persisted.coupon,
								providerReceiptId: `commerce-entitlement:${id}`,
							}
						}
						if (existing.length !== 0)
							return refuseCoupon('unexpected-existing-entitlement')
						// Recheck after proof/DB reads: binding never extends the canonical coupon window.
						const boundAt = checkWindow(
							persisted.coupon.issuedAt,
							persisted.coupon.expiresAt,
						)
						await tx.insertEntitlement({
							id,
							entitlementType: creditTypeId,
							userId,
							organizationId: null,
							organizationMembershipId: null,
							sourceType: 'COUPON',
							sourceId: row.id,
							metadata: {
								evergreenOffer: {
									journeyId,
									contactId: intent.contactId,
									intentKey: intent.idempotencyKey,
									sourceReference: proof.data.sourceReference,
								},
							},
							expiresAt: new Date(persisted.coupon.expiresAt),
							createdAt: new Date(boundAt),
							updatedAt: new Date(boundAt),
							deletedAt: null,
						})
						const insertedGrants = await tx.listCouponEntitlements(row.id)
						const insertedGrant = insertedGrants[0]
						if (
							insertedGrants.length !== 1 ||
							!insertedGrant ||
							insertedGrant.id !== id ||
							insertedGrant.userId !== userId ||
							insertedGrant.sourceId !== row.id ||
							insertedGrant.sourceType !== 'COUPON' ||
							insertedGrant.entitlementType !== creditTypeId ||
							insertedGrant.deletedAt !== null ||
							insertedGrant.organizationId !== null ||
							insertedGrant.organizationMembershipId !== null ||
							insertedGrant.expiresAt?.toISOString() !==
								persisted.coupon.expiresAt
						)
							return refuseCoupon('entitlement-readback-conflict')
						await tx.setCouponFields(row.id, {
							...row.fields,
							exclusive: true,
							evergreenOffer: {
								format: 1,
								issue: persisted.issue,
								binding: {
									type: 'BoundToVerifiedUser',
									verifiedUserId: userId,
									boundAt,
									intentKey: intent.idempotencyKey,
									entitlementId: id,
									sourceReference: proof.data.sourceReference,
								},
							},
						})
						const updated = await tx.getCoupon(row.id)
						if (!updated) return refuseCoupon('binding-readback-missing')
						const final = readCoupon(updated)
						if (
							final.binding.type !== 'BoundToVerifiedUser' ||
							final.binding.verifiedUserId !== userId ||
							final.binding.entitlementId !== id ||
							final.binding.boundAt !== boundAt ||
							JSON.stringify(final.issue) !== JSON.stringify(persisted.issue)
						)
							return refuseCoupon('binding-readback-conflict')
						return {
							coupon: final.coupon,
							providerReceiptId: `commerce-entitlement:${id}`,
						}
					},
				)
			}),
	}
}
