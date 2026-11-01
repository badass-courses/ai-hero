import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
	CC_PRODUCT,
	CreditRefusal,
	source,
	type CreditScope,
	type CreditSource,
	type CreditReceipt,
	type CreditStatus,
	type SourcePayment,
	type SourcePaymentReader,
} from './domain'

export type CreditTransaction = {
	sources: CreditSource[]
	spent: Map<string, number>
	receipt: CreditReceipt | null
	insert: (
		receipt: CreditReceipt,
		audit: Record<string, string>,
	) => Promise<void>
	settle: (status: CreditStatus) => Promise<void>
}
export interface CreditStore {
	locked<A>(
		scope: CreditScope,
		invoiceId: string | null,
		run: (tx: CreditTransaction) => Promise<A>,
	): Promise<A>
}
type SourceRow = RowDataPacket & {
	purchaseId: string
	productId: string
	status: string
	organizationId: string | null
	bulkOrganizationId: string | null
	siblingOrganizationIds: string | null
	customerId: string | null
	bulkCouponId: string | null
	redeemedBulkCouponId: string | null
	sourceMultiplicity: number
	bulkSeats: number | null
	totalAmount: string
	chargeIdentifier: string | null
	checkoutSessionIdentifier: string | null
	couponId: string | null
	promoId: string | null
	merchantCouponId: string | null
	couponType: string | null
}
const sourceQuery = `SELECT p.id AS purchaseId, p.productId, p.status, p.organizationId,
 mc.identifier AS customerId, p.bulkCouponId, p.redeemedBulkCouponId,
 bulk.maxUses AS bulkSeats, bulk.organizationId AS bulkOrganizationId,
 (SELECT GROUP_CONCAT(DISTINCT owner.organizationId) FROM AI_Purchase owner
  JOIN AI_MerchantCharge ownerCharge ON ownerCharge.id = owner.merchantChargeId
  WHERE owner.bulkCouponId = p.bulkCouponId AND owner.organizationId IS NOT NULL
  AND ownerCharge.merchantCustomerId = chargeRow.merchantCustomerId) AS siblingOrganizationIds,
 p.totalAmount, p.couponId,
 chargeRow.identifier AS chargeIdentifier, ms.identifier AS checkoutSessionIdentifier,
 (SELECT COUNT(*) FROM AI_Purchase sibling WHERE sibling.bulkCouponId = p.bulkCouponId
  AND sibling.productId = p.productId AND sibling.status IN ('Valid','Restricted')
  AND sibling.totalAmount > 0 AND sibling.redeemedBulkCouponId IS NULL) AS sourceMultiplicity,
 promo.id AS promoId, promo.merchantCouponId, discount.type AS couponType
 FROM AI_Purchase p
 LEFT JOIN AI_Coupon bulk ON bulk.id = p.bulkCouponId
 LEFT JOIN AI_Coupon promo ON promo.id = p.couponId
 LEFT JOIN AI_MerchantCoupon discount ON discount.id = promo.merchantCouponId
 LEFT JOIN AI_MerchantCharge chargeRow ON chargeRow.id = p.merchantChargeId
 LEFT JOIN AI_MerchantCustomer mc ON mc.id = chargeRow.merchantCustomerId
 LEFT JOIN AI_MerchantSession ms ON ms.id = p.merchantSessionId`
// Same rule as ledgerOrganizations, in SQL, for org-scope discovery.
const organizationScope = `(BINARY p.organizationId = ? OR (p.organizationId IS NULL
 AND (BINARY bulk.organizationId = ? OR EXISTS (SELECT 1 FROM AI_Purchase owner
  JOIN AI_MerchantCharge ownerCharge ON ownerCharge.id = owner.merchantChargeId
  WHERE owner.bulkCouponId = p.bulkCouponId AND BINARY owner.organizationId = ?
  AND ownerCharge.merchantCustomerId = chargeRow.merchantCustomerId))))`

/** A purchase's own org. Without one, the org of its bulk coupon or of the same
 * customer's other purchases on that coupon: add-seat checkouts can record no
 * org, but they add seats to the team's one coupon. */
function ledgerOrganizations(row: SourceRow) {
	if (row.organizationId) return [row.organizationId]
	return [
		...new Set(
			[
				row.bulkOrganizationId,
				...(row.siblingOrganizationIds?.split(',') ?? []),
			].filter((id): id is string => !!id),
		),
	]
}

/** Cheap DB-only filter, so Stripe is only asked about possible sources. */
function candidate(row: SourceRow, scope: CreditScope) {
	return (
		row.productId === CC_PRODUCT &&
		['Valid', 'Restricted'].includes(row.status) &&
		!!row.bulkCouponId &&
		!row.redeemedBulkCouponId &&
		(scope.organizationId
			? ledgerOrganizations(row).includes(scope.organizationId)
			: row.customerId === scope.stripeCustomerId) &&
		Number(row.totalAmount) > 0 &&
		row.couponType?.toLowerCase() !== 'ppp'
	)
}
function eligible(
	row: SourceRow,
	scope: CreditScope,
	payment: SourcePayment | undefined,
): CreditSource | null {
	if (!candidate(row, scope)) return null
	if (scope.organizationId && ledgerOrganizations(row).length > 1)
		throw new CreditRefusal('bulk_coupon_organization_ambiguous_hold_for_review')
	if (
		row.couponId &&
		(!row.promoId || !row.merchantCouponId || !row.couponType)
	)
		throw new CreditRefusal('coupon_evidence_missing_hold_for_review')
	if (row.bulkSeats === null)
		throw new CreditRefusal('bulk_seat_evidence_missing')
	if (!payment)
		throw new CreditRefusal('source_payment_evidence_missing_hold_for_review')
	if ('hold' in payment) throw new CreditRefusal(payment.hold)
	// Add-seat purchases share the team's bulk coupon, whose maxUses is the
	// running total. Only the checkout quantity says what this purchase bought.
	const seats =
		payment.seats ??
		(Number(row.sourceMultiplicity) === 1 ? Number(row.bulkSeats) : null)
	if (seats === null)
		throw new CreditRefusal('shared_bulk_coupon_source_hold_for_review')
	if (seats > Number(row.bulkSeats))
		throw new CreditRefusal('purchase_seats_exceed_bulk_coupon_hold_for_review')
	return source({
		purchaseId: row.purchaseId,
		purchaseSeats: seats,
		chargeCents: payment.chargeCents,
		recordedAmount: row.totalAmount,
	})
}

/** Plain SELECT, safe on a read-only role: has this Stripe customer ever bought
 * Crash Course seats on a bulk coupon, in any status? */
export async function customerBoughtTeamSeats(
	pool: Pick<Pool, 'execute'>,
	stripeCustomerId: string,
) {
	const [rows] = await pool.execute<RowDataPacket[]>(
		`SELECT 1 FROM AI_Purchase p
		 JOIN AI_MerchantCharge chargeRow ON chargeRow.id = p.merchantChargeId
		 JOIN AI_MerchantCustomer mc ON mc.id = chargeRow.merchantCustomerId
		 WHERE p.productId = ? AND p.bulkCouponId IS NOT NULL AND BINARY mc.identifier = ?
		 LIMIT 1`,
		[CC_PRODUCT, stripeCustomerId],
	)
	return rows.length > 0
}

/** All mutations and balance reads share this transaction/lock order.
 * Discovery can undercount a concurrently added purchase, but cannot overdraw it.
 * No remote API calls may run while this callback holds database locks:
 * readPayments runs during discovery, before the transaction begins.
 */
export function mysqlCreditStore(
	acquire: () => Promise<PoolConnection>,
	readPayments: SourcePaymentReader,
): CreditStore {
	return {
		async locked(scope, invoiceId, run) {
			const connection = await acquire()
			try {
				if (!scope.organizationId && !scope.stripeCustomerId)
					throw new CreditRefusal('scope_required')
				if (scope.organizationId && scope.stripeCustomerId) {
					const [proof] = await connection.execute<RowDataPacket[]>(
						`SELECT mc.id FROM AI_MerchantCustomer mc
						 LEFT JOIN AI_MerchantCharge c ON c.merchantCustomerId = mc.id
						 LEFT JOIN AI_Purchase p ON p.merchantChargeId = c.id
						 WHERE BINARY mc.identifier = ? AND (BINARY mc.organizationId = ? OR BINARY p.organizationId = ?) LIMIT 1`,
						[
							scope.stripeCustomerId,
							scope.organizationId,
							scope.organizationId,
						],
					)
					if (!proof.length)
						throw new CreditRefusal('invoice_customer_org_mismatch')
				}
				const [candidates] = await connection.execute<RowDataPacket[]>(
					`${sourceQuery} WHERE p.productId = ? AND p.bulkCouponId IS NOT NULL AND ${scope.organizationId ? organizationScope : 'BINARY mc.identifier = ?'}`,
					scope.organizationId
						? [CC_PRODUCT, ...Array(3).fill(scope.organizationId)]
						: [CC_PRODUCT, scope.stripeCustomerId],
				)
				const [prior] = invoiceId
					? await connection.execute<RowDataPacket[]>(
							'SELECT purchaseId FROM AI_CcCreditAllocation WHERE invoiceId = ?',
							[invoiceId],
						)
					: [[]]
				const ids = [
					...new Set(
						[...candidates, ...prior].map((row) => String(row.purchaseId)),
					),
				].sort()
				const discovered = new Map(
					candidates.map((row) => [String(row.purchaseId), row as SourceRow]),
				)
				for (const id of ids)
					if (!discovered.has(id)) {
						const [rows] = await connection.execute<SourceRow[]>(
							`${sourceQuery} WHERE p.id = ? AND BINARY p.id = ?`,
							[id, id],
						)
						if (rows[0]) discovered.set(id, rows[0])
					}
				const payable = [...discovered.values()].filter((row) =>
					candidate(row, scope),
				)
				const payments = payable.length
					? await readPayments(
							payable.map((row) => ({
								purchaseId: row.purchaseId,
								chargeIdentifier: row.chargeIdentifier,
								checkoutSessionIdentifier: row.checkoutSessionIdentifier,
							})),
						)
					: new Map<string, SourcePayment>()
				await connection.beginTransaction()
				const sources: CreditSource[] = []
				for (const id of ids) {
					// Lock the canonical purchase before any ledger row. One point
					// lookup at a time guarantees the same order for every alias.
					const [locked] = await connection.execute<RowDataPacket[]>(
						'SELECT id FROM AI_Purchase WHERE id = ? AND BINARY id = ? FOR UPDATE',
						[id, id],
					)
					if (locked.length !== 1)
						throw new CreditRefusal('source_purchase_missing')
				}
				for (const id of ids) {
					const [rows] = await connection.execute<SourceRow[]>(
						`${sourceQuery} WHERE p.id = ? AND BINARY p.id = ? FOR UPDATE`,
						[id, id],
					)
					const value =
						rows[0] && eligible(rows[0], scope, payments.get(id))
					if (value) sources.push(value)
				}
				const [receipts] = invoiceId
					? await connection.execute<RowDataPacket[]>(
							'SELECT * FROM AI_CcCreditReservation WHERE invoiceId = ? FOR UPDATE',
							[invoiceId],
						)
					: [[]]
				let receipt: CreditReceipt | null = null
				if (receipts[0]) {
					const row = receipts[0]
					const [allocations] = await connection.execute<RowDataPacket[]>(
						'SELECT * FROM AI_CcCreditAllocation WHERE invoiceId = ? ORDER BY purchaseId FOR UPDATE',
						[invoiceId],
					)
					receipt = {
						invoiceId: row.invoiceId,
						stripeCustomerId: row.stripeCustomerId,
						...(row.organizationId
							? { organizationId: row.organizationId }
							: {}),
						requestHash: row.requestHash,
						seats: row.seats,
						amountCents: Number(row.amountCents),
						currency: row.currency,
						status: row.status,
						allocations: allocations.map((a) => ({
							purchaseId: a.purchaseId,
							seats: a.seats,
							perSeatCents: Number(a.perSeatCents),
							purchaseSeats: a.purchaseSeats,
							purchaseTotalCents: Number(a.purchaseTotalCents),
						})),
					}
				}
				const spent = new Map<string, number>()
				for (const id of ids) {
					// A locking read is essential: a consistent snapshot established
					// before waiting on a source lock could otherwise miss a commit.
					const [allocations] = await connection.execute<RowDataPacket[]>(
						`SELECT a.seats, r.status FROM AI_CcCreditAllocation a
						 LEFT JOIN AI_CcCreditReservation r ON r.invoiceId = a.invoiceId
						 WHERE a.purchaseId = ? FOR UPDATE`,
						[id],
					)
					if (
						allocations.some(
							(row) => !['reserved', 'paid', 'released'].includes(row.status),
						)
					)
						throw new CreditRefusal('orphan_or_invalid_ledger_hold_for_review')
					spent.set(
						id,
						allocations.reduce(
							(sum, row) => sum + (row.status === 'released' ? 0 : row.seats),
							0,
						),
					)
				}
				const result = await run({
					sources,
					spent,
					receipt,
					insert: async (row, audit) => {
						await connection.execute(
							`INSERT INTO AI_CcCreditReservation (invoiceId, stripeCustomerId, organizationId, requestHash, seats, amountCents, currency, status, audit, createdAt, updatedAt, paidAt, releasedAt)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3), IF(? = 'paid', NOW(3), NULL), IF(? = 'released', NOW(3), NULL))`,
							[
								row.invoiceId,
								row.stripeCustomerId,
								row.organizationId ?? null,
								row.requestHash,
								row.seats,
								row.amountCents,
								row.currency,
								row.status,
								JSON.stringify(audit),
								row.status,
								row.status,
							],
						)
						for (const a of row.allocations)
							await connection.execute(
								`INSERT INTO AI_CcCreditAllocation (invoiceId, purchaseId, seats, perSeatCents, purchaseSeats, purchaseTotalCents) VALUES (?, ?, ?, ?, ?, ?)`,
								[
									row.invoiceId,
									a.purchaseId,
									a.seats,
									a.perSeatCents,
									a.purchaseSeats,
									a.purchaseTotalCents,
								],
							)
					},
					settle: async (status) => {
						await connection.execute(
							`UPDATE AI_CcCreditReservation SET status = ?, updatedAt = NOW(3), paidAt = IF(? = 'paid', COALESCE(paidAt, NOW(3)), paidAt), releasedAt = IF(? = 'released', COALESCE(releasedAt, NOW(3)), releasedAt) WHERE invoiceId = ? AND status = 'reserved'`,
							[status, status, status, invoiceId],
						)
					},
				})
				await connection.commit()
				return result
			} catch (error) {
				await connection.rollback().catch(() => undefined)
				throw error
			} finally {
				connection.release()
			}
		},
	}
}
