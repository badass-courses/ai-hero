import { createHash } from 'node:crypto'
import { acquireDatabaseConnection, courseBuilderAdapter, db } from '@/db'
import { merchantSession, purchases } from '@/db/schema'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { EARLY_ACCESS_REVOKE_EVENT } from '@/inngest/events/early-access'
import { and, eq, or, sql } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2/promise'
import Stripe from 'stripe'
import {
	NEW_PURCHASE_CREATED_EVENT,
	PURCHASE_BENEFITS_ATTACHED_EVENT,
} from '@coursebuilder/core/events/commerce'
import {
	type EarlyAccessPorts,
	invoiceReadback,
	needsReview,
} from './early-access'
import { createEarlyAccessPurchase } from './early-access-purchase'

export const earlyAccessStripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
	apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
})

export const earlyAccessPorts: EarlyAccessPorts = {
	invoice: (id) =>
		earlyAccessStripe.invoices.retrieve(id, {
			expand: ['customer', 'lines.data.price.product'],
		}),
	mark: (id, metadata) => earlyAccessStripe.invoices.update(id, { metadata }),
	purchases: async (id) => {
		const rows = await db
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
	create: async (invoice, at) => {
		const { magicLinkIdentity } = await import('@/coursebuilder/email-provider')
		return createEarlyAccessPurchase(
			db,
			invoice,
			at,
			magicLinkIdentity.findOrCreateUser,
		)
	},
	lock: async (id, work) => {
		const connection = await acquireDatabaseConnection()
		const key = `early-access:${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
		let locked = false
		try {
			const [[row]] = await connection.query<
				(RowDataPacket & { acquired: number })[]
			>('SELECT GET_LOCK(?, 0) AS acquired', [key])
			if (row?.acquired !== 1)
				throw new Error(
					'Another early-access operation holds this invoice; retry after its readback',
				)
			locked = true
			return await work()
		} finally {
			try {
				if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [key])
			} finally {
				connection.release()
			}
		}
	},
	notify: async (invoice, purchase) => {
		const full = await courseBuilderAdapter.getPurchase(purchase.id)
		if (!full || !full.userId || full.status !== 'Valid')
			throw new Error('Grant purchase is not valid')
		if (full.fields?.earlyAccessNotifiedAt) return
		const user = await courseBuilderAdapter.getUserById(full.userId)
		const product = await courseBuilderAdapter.getProduct(full.productId)
		if (!user) throw new Error('Grant user missing')
		// Stable event IDs let an interrupted CLI rerun without duplicate welcome
		// or Discord workflows. These are the same events the paid path emits.
		await inngest.send({
			id: `early-access:${purchase.id}`,
			name: NEW_PURCHASE_CREATED_EVENT,
			data: {
				txnId: `early-access:${invoice.id}`,
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
			await inngest.send({
				id: `early-access-benefits:${purchase.id}`,
				name: PURCHASE_BENEFITS_ATTACHED_EVENT,
				data: {
					txnId: `early-access:${invoice.id}`,
					purchaseId: purchase.id,
					userId: user.id,
					productId: full.productId,
					invoiceId: invoice.id,
					purchaseBenefitIds: full.fields.purchaseBenefits.map(
						(b: { id: string }) => b.id,
					),
				},
				user: { id: user.id, email: user.email, role: user.role },
			})
		await db
			.update(purchases)
			.set({
				fields: {
					...full.fields,
					earlyAccessNotifiedAt: new Date().toISOString(),
				},
			})
			.where(eq(purchases.id, full.id))
	},
	revoke: async (purchase) => {
		// Existing refund-entitlements workflow handles redeemed team seats,
		// coupon revocation, memberships, credits and Discord role cleanup.
		await db
			.update(purchases)
			.set({ status: 'Refunded' })
			.where(and(eq(purchases.id, purchase.id), eq(purchases.status, 'Valid')))
		await inngest.send({
			id: `early-access-revoke:${purchase.id}`,
			name: EARLY_ACCESS_REVOKE_EVENT,
			data: {
				purchaseId: purchase.id,
				invoiceId: String(purchase.fields?.invoiceId),
			},
		})
	},
}

export async function reportEarlyAccess() {
	const rows = []
	for (const status of ['open', 'void', 'uncollectible'] as const) {
		for await (const invoice of earlyAccessStripe.invoices.list({
			status,
			limit: 100,
		})) {
			if (!needsReview(invoice)) continue
			const linked = await earlyAccessPorts.purchases(invoice.id)
			rows.push({
				...invoiceReadback(invoice, linked),
				metadataPurchaseId: invoice.metadata?.earlyAccessPurchaseId ?? null,
				needsRepair:
					linked.length !== 1 ||
					linked[0]?.id !== invoice.metadata?.earlyAccessPurchaseId,
			})
		}
	}
	return { state: 'report', dryRun: true, grants: rows }
}
