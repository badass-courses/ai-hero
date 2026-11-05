import { merchantSession, purchases } from '@/db/schema'
import type { DbExecutor } from '@/db'
import { updatePurchaseFields } from '@/lib/purchase-fields-write'
import { and, eq, or, sql } from 'drizzle-orm'
import type { PoolConnection } from 'mysql2/promise'
import type Stripe from 'stripe'
import type { User } from '@coursebuilder/core/schemas'
import type { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { inngest } from '@/inngest/inngest.server'
import { EARLY_ACCESS_REVOKE_EVENT } from '@/inngest/events/early-access'
import {
	NEW_PURCHASE_CREATED_EVENT,
	PURCHASE_BENEFITS_ATTACHED_EVENT,
} from '@coursebuilder/core/events/commerce'
import {
	EARLY_ACCESS,
	type EarlyAccessPorts,
	type EarlyPurchase,
	invoiceReadback,
	needsReview,
} from './early-access'
import { createEarlyAccessLock } from './early-access-lock'
import {
	createEarlyAccessPurchase,
	inspectEarlyAccessPurchase,
	type EarlyAccessDatabase,
} from './early-access-purchase'

type Adapter = Pick<
	ReturnType<typeof DrizzleAdapter>,
	'getPurchase' | 'getUserById' | 'getProduct' | 'getMerchantCharge'
>
export type EarlyAccessDependencies = {
	database: EarlyAccessDatabase
	adapter: Adapter
	stripe: Stripe
	findUser(email: string): Promise<{ user: User }>
	acquireConnection(): Promise<PoolConnection>
	send(event: Parameters<typeof inngest.send>[0]): Promise<unknown>
}

/** Production and sandbox use this exact factory, including Stripe expansion,
 * identity resolution, event payloads and the real MySQL lock. */
export function createEarlyAccessPorts(
	deps: EarlyAccessDependencies,
): EarlyAccessPorts {
	const { database, adapter, stripe } = deps
	return {
		invoice: (id) =>
			stripe.invoices.retrieve(id, {
				expand: ['customer', 'lines.data.price.product'],
			}),
		mark: (id, metadata) => stripe.invoices.update(id, { metadata }),
		purchases: async (id) => {
			const rows = await database
				.select({ purchase: purchases })
				.from(purchases)
				.leftJoin(
					merchantSession,
					eq(merchantSession.id, purchases.merchantSessionId),
				)
				.where(
					or(
						eq(merchantSession.identifier, id),
						sql`JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.invoiceId')) = ${id}`,
					),
				)
			return rows.map((row) => row.purchase)
		},
		preflight: async (invoice) => {
			await inspectEarlyAccessPurchase(database, invoice)
		},
		create: (invoice, at) =>
			createEarlyAccessPurchase(database, invoice, at, deps.findUser),
		lock: createEarlyAccessLock(deps.acquireConnection),
		notify: async (invoice, purchase) => {
			const full = await adapter.getPurchase(purchase.id)
			if (!full || !full.userId || full.status !== 'Valid')
				throw new Error('Grant purchase is not valid')
			if (full.fields?.earlyAccessNotifiedAt) return
			const user = await adapter.getUserById(full.userId)
			const product = await adapter.getProduct(full.productId)
			if (!user) throw new Error('Grant user missing')
			await deps.send({
				id: `early-access:${purchase.id}`,
				name: NEW_PURCHASE_CREATED_EVENT,
				data: {
					purchaseId: purchase.id,
					checkoutSessionId: null,
					invoiceId: invoice.id,
					productType: product?.type || 'self-paced',
					quantity: Number(full.fields?.quantity),
					customerEmail: user.email!,
				},
				user: { id: user.id, email: user.email, role: user.role },
			})
			if (full.fields?.purchaseBenefits?.length && !full.bulkCouponId)
				await deps.send({
					id: `early-access-benefits:${purchase.id}`,
					name: PURCHASE_BENEFITS_ATTACHED_EVENT,
					data: {
						purchaseId: purchase.id,
						userId: user.id,
						productId: full.productId,
						invoiceId: invoice.id,
						purchaseBenefitIds: full.fields.purchaseBenefits.map(
							(b: { id: string }) => b.id,
						),
					},
					user: { id: user.id, email: user.email },
				})
			await updatePurchaseFields({
				purchaseId: full.id,
				patch: { earlyAccessNotifiedAt: new Date().toISOString() },
				executor: database as DbExecutor,
			})
		},
		revoke: async (purchase) => {
			// Zero matched rows means another state won; never dispatch cleanup.
			const changed = await updatePurchaseFields({
				purchaseId: purchase.id,
				patch: {},
				columns: { status: 'Refunded' },
				where: and(
					eq(purchases.status, 'Valid'),
					sql`${purchases.merchantChargeId} IS NULL`,
				),
				executor: database as DbExecutor,
			})
			if (changed.rowsAffected !== 1)
				throw new Error(
					'Purchase status changed; no revocation event sent. Inspect the current purchase and cleanup workflow.',
				)
			await deps.send({
				id: `early-access-revoke:${purchase.id}`,
				name: EARLY_ACCESS_REVOKE_EVENT,
				data: {
					purchaseId: purchase.id,
					invoiceId: String(purchase.fields?.invoiceId),
				},
			})
		},
	}
}

export async function earlyAccessRepairReasons(
	invoice: Stripe.Invoice,
	linked: EarlyPurchase[],
	adapter: Pick<Adapter, 'getMerchantCharge'>,
) {
	const reasons = []
	const purchase = linked[0]
	if (
		linked.length !== 1 ||
		!purchase ||
		purchase.id !== invoice.metadata?.earlyAccessPurchaseId ||
		purchase.fields?.earlyAccess !== true ||
		purchase.fields.invoiceId !== invoice.id
	)
		reasons.push('purchase-identity')
	if (invoice.status === 'paid' && invoice.amount_paid > 0 && purchase) {
		const stripeChargeId =
			typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id
		const charge = purchase.merchantChargeId
			? await adapter.getMerchantCharge(purchase.merchantChargeId)
			: null
		if (!stripeChargeId || charge?.identifier !== stripeChargeId)
			reasons.push('charge-link')
		if (Math.round(Number(purchase.totalAmount) * 100) !== invoice.amount_paid)
			reasons.push('paid-amount')
		if (!purchase.fields?.earlyAccessPaidAt) reasons.push('payment-receipt')
	}
	return reasons
}

export async function reportEarlyAccessWithPorts(
	deps: Pick<EarlyAccessDependencies, 'stripe' | 'adapter'>,
	ports: EarlyAccessPorts,
) {
	const rows = []
	// Search only marked invoices, not every invoice in three complete catalogs.
	// Stripe search is eventually consistent; the invoice-specific grant command
	// always performs direct authoritative retrieval instead.
	for await (const invoice of deps.stripe.invoices.search({
		query: `metadata['accessProvisioning']:'${EARLY_ACCESS}'`,
		limit: 100,
	})) {
		const linked = await ports.purchases(invoice.id)
		const repairReasons = await earlyAccessRepairReasons(
			invoice,
			linked,
			deps.adapter,
		)
		if (
			!needsReview(invoice) &&
			!(invoice.status === 'paid' && repairReasons.length)
		)
			continue
		rows.push({
			...invoiceReadback(invoice, linked),
			metadataPurchaseId: invoice.metadata?.earlyAccessPurchaseId ?? null,
			needsRepair: repairReasons.length > 0,
			repairReasons,
		})
	}
	return {
		state: 'report',
		dryRun: true,
		searchConsistency: 'eventual',
		grants: rows,
	}
}
