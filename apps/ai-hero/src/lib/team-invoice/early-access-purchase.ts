import { randomUUID } from 'node:crypto'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type Stripe from 'stripe'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { User } from '@coursebuilder/core/schemas'
import { parseAndExpandPurchaseBenefitTransport } from '@coursebuilder/commerce/purchase-benefit-transport'
import {
	assertInvoiceContent,
	invoiceCustomerEmail,
	type EarlyPurchase,
} from './early-access'

export type EarlyAccessDatabase = MySqlDatabase<any, any, typeof schema>
type Database = EarlyAccessDatabase

/** Read-only validation runs before the manual marker, including on dry runs.
 * Rechecked at creation because provider and database state may have changed. */
export async function inspectEarlyAccessPurchase(
	database: Database,
	invoice: Stripe.Invoice,
) {
	assertInvoiceContent(invoice)
	const adapter = DrizzleAdapter(database, mysqlTable)
	const line = invoice.lines.data.find(
		(item) => item.price?.product && item.amount > 0,
	)!
	const stripeProduct = line.price!.product
	const productId =
		typeof stripeProduct === 'string' ? stripeProduct : stripeProduct.id
	const merchantProduct = await database.query.merchantProduct.findFirst({
		where: and(
			eq(schema.merchantProduct.identifier, productId),
			eq(schema.merchantProduct.status, 1),
		),
	})
	const merchantAccount = await database.query.merchantAccount.findFirst({
		where: and(
			eq(schema.merchantAccount.label, 'stripe'),
			eq(schema.merchantAccount.status, 1),
		),
	})
	const product = merchantProduct
		? await database.query.products.findFirst({
				where: eq(schema.products.id, merchantProduct.productId),
			})
		: null
	if (
		!merchantProduct ||
		!merchantAccount ||
		!product ||
		merchantProduct.merchantAccountId !== merchantAccount.id
	)
		throw new Error('Invoice product or merchant account is not configured')
	const knownUser = await database.query.users.findFirst({
		where: eq(schema.users.email, invoiceCustomerEmail(invoice)!),
	})
	if (
		knownUser &&
		(await database.query.purchases.findFirst({
			where: and(
				eq(schema.purchases.userId, knownUser.id),
				eq(schema.purchases.productId, merchantProduct.productId),
				inArray(schema.purchases.status, ['Valid', 'Restricted']),
				ne(schema.purchases.id, `early_${invoice.id}`),
			),
		}))
	)
		throw new Error(
			'Invoice customer already holds a Valid purchase of this product; refusing early access',
		)
	const quantity = line.quantity!
	const organizationId = invoice.metadata?.organizationId
	const expansion = invoice.metadata?.purchaseBenefits
		? parseAndExpandPurchaseBenefitTransport({
				transport: invoice.metadata.purchaseBenefits,
				appliesTo: quantity > 1 ? 'redeemed_team_seat' : 'buyer',
			})
		: null
	if (expansion && !expansion.success)
		throw new Error('Invoice purchase benefits need review before granting')
	const benefitFields = expansion?.success
		? { purchaseBenefits: expansion.benefits }
		: {}
	return {
		adapter,
		merchantProduct,
		merchantAccount,
		quantity,
		organizationId,
		benefitFields,
	}
}

/** App-owned unpaid seam. No MerchantCharge, no invented paid amount.
 * Purchase, team coupon, invoice session and transfer commit together. */
export async function createEarlyAccessPurchase(
	database: Database,
	invoice: Stripe.Invoice,
	grantedAt: string,
	findUser?: (email: string) => Promise<{ user: User }>,
): Promise<EarlyPurchase> {
	const {
		adapter,
		merchantProduct,
		merchantAccount,
		quantity,
		organizationId,
		benefitFields,
	} = await inspectEarlyAccessPurchase(database, invoice)
	const { user } = await (findUser ?? adapter.findOrCreateUser)(
		invoiceCustomerEmail(invoice)!,
	)
	return database.transaction(async (tx) => {
		const purchaseId = `early_${invoice.id}`
		const scoped = DrizzleAdapter(tx as unknown as Database, mysqlTable)
		const prior = await scoped.getPurchase(purchaseId)
		if (prior) return prior
		const customerId =
			typeof invoice.customer === 'string'
				? invoice.customer
				: invoice.customer!.id
		await scoped.findOrCreateMerchantCustomer({
			user,
			identifier: customerId,
			merchantAccountId: merchantAccount.id,
		})
		const session = await scoped.createMerchantSession({
			identifier: invoice.id,
			merchantAccountId: merchantAccount.id,
			organizationId,
		})
		const bulkCouponId = quantity > 1 ? `early_${randomUUID()}` : null
		if (bulkCouponId)
			await tx.insert(schema.coupon).values({
				id: bulkCouponId,
				percentageDiscount: '1.0',
				restrictedToProductId: merchantProduct.productId,
				maxUses: quantity,
				usedCount: 0,
				status: 1,
				default: false,
				fields: benefitFields,
				...(organizationId ? { organizationId } : {}),
			})
		const options = {
			id: purchaseId,
			userId: user.id,
			productId: merchantProduct.productId,
			status: 'Valid',
			totalAmount: '0.00',
			merchantSessionId: String(session.id),
			bulkCouponId,
			...(organizationId ? { organizationId } : {}),
			fields: {
				...(bulkCouponId ? {} : benefitFields),
				earlyAccess: true,
				earlyAccessBillingUserId: user.id,
				invoiceId: invoice.id,
				earlyAccessGrantedAt: grantedAt,
				grantRef: purchaseId,
				paymentStatusAtGrant: 'unpaid',
				quantity,
			},
		}
		const purchase = await scoped.createPurchase(options)
		await tx.insert(schema.purchaseUserTransfer).values({
			id: `put_${randomUUID()}`,
			purchaseId,
			sourceUserId: user.id,
			expiresAt: new Date(Date.now() + 7 * 86400_000),
			...(organizationId ? { organizationId } : {}),
		})
		return purchase
	})
}
