import { randomUUID } from 'node:crypto'
import * as schema from '@/db/schema'
import type { DbExecutor } from '@/db'
import { updatePurchaseFields } from '@/lib/purchase-fields-write'
import { and, eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import {
	EARLY_ACCESS,
	grantMetadata,
	type EarlyAccessPorts,
} from './early-access'
import type { EarlyAccessDatabase } from './early-access-purchase'

type PaymentLog = {
	error(event: string, fields: Record<string, unknown>): Promise<unknown>
}

/** Link money to the existing access record. Never create another purchase or
 * coupon, never restore a refunded status, and never invent a Stripe charge. */
export async function linkEarlyAccessPayment(
	database: EarlyAccessDatabase,
	invoice: Stripe.Invoice,
	purchaseId: string,
) {
	if (invoice.status !== 'paid' || invoice.amount_paid <= 0)
		throw new Error('Early-access payment is not a positive paid invoice')
	const chargeId =
		typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id
	const customerId =
		typeof invoice.customer === 'string'
			? invoice.customer
			: invoice.customer?.id
	if (!chargeId || !customerId)
		throw new Error('Early-access payment has no charge or customer')
	return database.transaction(async (tx) => {
		const [purchase] = await tx
			.select()
			.from(schema.purchases)
			.where(eq(schema.purchases.id, purchaseId))
			.for('update')
		if (
			!purchase ||
			purchase.fields?.earlyAccess !== true ||
			purchase.fields.invoiceId !== invoice.id
		)
			throw new Error('Early-access payment purchase identity mismatch')
		if (purchase.status !== 'Valid')
			throw new Error('Early-access payment purchase is not Valid')
		// Access transfers move the purchase holder, not the original payer.
		const billingUserId =
			typeof purchase.fields.earlyAccessBillingUserId === 'string'
				? purchase.fields.earlyAccessBillingUserId
				: purchase.userId
		if (!billingUserId) throw new Error('Early-access payment payer missing')
		const session = purchase.merchantSessionId
			? await tx.query.merchantSession.findFirst({
					where: eq(schema.merchantSession.id, purchase.merchantSessionId),
				})
			: null
		if (!session || session.identifier !== invoice.id)
			throw new Error('Early-access payment invoice session mismatch')
		const productLine = invoice.lines.data.find(
			(line) => line.price?.product && line.amount > 0,
		)
		const stripeProduct = productLine?.price?.product
		const stripeProductId =
			typeof stripeProduct === 'string' ? stripeProduct : stripeProduct?.id
		if (!stripeProductId)
			throw new Error('Early-access payment product missing')
		const merchantProduct = await tx.query.merchantProduct.findFirst({
			where: and(
				eq(schema.merchantProduct.identifier, stripeProductId),
				eq(schema.merchantProduct.productId, purchase.productId),
				eq(schema.merchantProduct.merchantAccountId, session.merchantAccountId),
			),
		})
		const customer = await tx.query.merchantCustomer.findFirst({
			where: and(
				eq(schema.merchantCustomer.identifier, customerId),
				eq(schema.merchantCustomer.userId, billingUserId),
				eq(
					schema.merchantCustomer.merchantAccountId,
					session.merchantAccountId,
				),
			),
		})
		if (
			!merchantProduct ||
			merchantProduct.identifier !== stripeProductId ||
			!customer
		)
			throw new Error('Early-access payment product or customer mismatch')
		const charges = await tx
			.select()
			.from(schema.merchantCharge)
			.where(eq(schema.merchantCharge.identifier, chargeId))
			.for('update')
		if (charges.length > 1)
			throw new Error('Early-access payment charge is ambiguous')
		const charge = charges[0]
		const merchantChargeId = charge?.id ?? `mc_early_${randomUUID()}`
		if (
			charge &&
			(charge.userId !== billingUserId ||
				charge.merchantCustomerId !== customer.id ||
				charge.merchantProductId !== merchantProduct.id ||
				charge.merchantAccountId !== session.merchantAccountId)
		)
			throw new Error('Early-access payment charge identity mismatch')
		if (purchase.merchantChargeId && purchase.merchantChargeId !== charge?.id)
			throw new Error('Early-access purchase already has another charge')
		if (charge) {
			const owners = await tx
				.select({ id: schema.purchases.id })
				.from(schema.purchases)
				.where(eq(schema.purchases.merchantChargeId, charge.id))
				.for('update')
			if (owners.some((owner) => owner.id !== purchase.id))
				throw new Error('Early-access charge belongs to another purchase')
		} else {
			await tx.insert(schema.merchantCharge).values({
				id: merchantChargeId,
				userId: billingUserId,
				identifier: chargeId,
				merchantAccountId: session.merchantAccountId,
				merchantProductId: merchantProduct.id,
				merchantCustomerId: customer.id,
				...(purchase.organizationId
					? { organizationId: purchase.organizationId }
					: {}),
			})
		}
		const paidAt = new Date(
			(invoice.status_transitions.paid_at ?? invoice.created) * 1000,
		).toISOString()
		await updatePurchaseFields({
			purchaseId: purchase.id,
			patch: { earlyAccessPaidAt: paidAt, earlyAccessChargeId: chargeId },
			columns: {
				merchantChargeId,
				totalAmount: (invoice.amount_paid / 100).toFixed(2),
			},
			executor: tx as DbExecutor,
		})
		return {
			purchaseId: purchase.id,
			chargeId,
			merchantChargeId,
			amountPaid: invoice.amount_paid,
		}
	})
}

/** Called only after the signed Stripe webhook is verified. Retrieval, grant
 * recovery and charge linkage use the same lock as operator grant and revoke. */
export async function reconcileEarlyAccessInvoicePayment(
	deps: {
		database: EarlyAccessDatabase
		ports: EarlyAccessPorts
		log: PaymentLog
	},
	invoiceId: string,
) {
	return deps.ports.lock(invoiceId, async () => {
		const invoice = await deps.ports.invoice(invoiceId)
		if (invoice.metadata?.accessProvisioning !== EARLY_ACCESS)
			return { state: 'not_early_access' }
		if (invoice.status !== 'paid' || invoice.amount_paid <= 0)
			throw new Error('Early-access payment is not a positive paid invoice')
		let linked = await deps.ports.purchases(invoiceId)
		if (linked.length > 1)
			throw new Error('DOUBLE: marked paid invoice has multiple purchases')
		let purchase = linked[0]
		if (purchase?.status === 'Refunded') {
			const chargeId =
				typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id
			if (
				purchase.fields?.earlyAccessPaidAt &&
				purchase.fields.earlyAccessChargeId === chargeId
			)
				return { state: 'paid_already_refunded', purchaseId: purchase.id }
			await deps.log.error('invoice.early_access.paid_after_revoke', {
				invoiceId,
				purchaseId: purchase.id,
			})
			return { state: 'paid_after_revoke', purchaseId: purchase.id }
		}
		if (!purchase) {
			await deps.log.error('invoice.early_access.paid_without_grant', {
				invoiceId,
			})
			if (
				invoice.metadata.earlyAccessPurchaseId &&
				invoice.metadata.earlyAccessPurchaseId !== `early_${invoiceId}`
			)
				throw new Error(
					'Early-access payment grant reference mismatch; operator review required',
				)
			await deps.ports.preflight(invoice)
			purchase = await deps.ports.create(
				invoice,
				invoice.metadata.earlyAccessGrantedAt ||
					new Date(invoice.created * 1000).toISOString(),
			)
			linked = await deps.ports.purchases(invoiceId)
			if (linked.length !== 1 || linked[0]?.id !== purchase.id)
				throw new Error('DOUBLE: paid grant recovery found multiple purchases')
		}
		if (
			purchase.status !== 'Valid' ||
			purchase.fields?.earlyAccess !== true ||
			purchase.fields.invoiceId !== invoiceId ||
			(invoice.metadata.earlyAccessPurchaseId &&
				invoice.metadata.earlyAccessPurchaseId !== purchase.id)
		)
			throw new Error('Early-access payment grant identity or status mismatch')
		const grantedAt =
			typeof purchase.fields.earlyAccessGrantedAt === 'string'
				? purchase.fields.earlyAccessGrantedAt
				: invoice.metadata.earlyAccessGrantedAt
		if (!grantedAt)
			throw new Error('Early-access payment grant timestamp missing')
		const receipt = await linkEarlyAccessPayment(
			deps.database,
			invoice,
			purchase.id,
		)
		await deps.ports.mark(invoiceId, grantMetadata(grantedAt, purchase.id))
		await deps.ports.notify(invoice, purchase)
		return { state: 'paid_linked', ...receipt }
	})
}
