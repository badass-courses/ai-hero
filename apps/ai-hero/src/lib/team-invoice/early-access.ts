import type Stripe from 'stripe'

export const EARLY_ACCESS = 'manual_early_access_granted'
export const AUTOMATIC_ACCESS = 'automatic_on_invoice_payment_succeeded'

export type EarlyPurchase = {
	id: string
	status: string
	fields?: Record<string, unknown> | null
}
export type EarlyAccessPorts = {
	invoice(id: string): Promise<Stripe.Invoice>
	mark(id: string, metadata: Record<string, string>): Promise<unknown>
	purchases(id: string): Promise<EarlyPurchase[]>
	create(invoice: Stripe.Invoice, grantedAt: string): Promise<EarlyPurchase>
	notify(invoice: Stripe.Invoice, purchase: EarlyPurchase): Promise<void>
	revoke(purchase: EarlyPurchase): Promise<void>
	lock<T>(id: string, work: () => Promise<T>): Promise<T>
}

export function maskEmail(email: string | null | undefined) {
	if (!email?.includes('@')) return null
	return `${email[0]}***@${email.split('@')[1]}`
}

// Match the paid handler: current expanded customer email wins over the
// invoice's billing snapshot. Never accept an operator-supplied seat email.
export function invoiceCustomerEmail(invoice: Stripe.Invoice) {
	const customer = invoice.customer
	return customer && typeof customer !== 'string' && !customer.deleted
		? (customer.email ?? invoice.customer_email)
		: invoice.customer_email
}

export function invoiceReadback(
	invoice: Stripe.Invoice,
	purchases: EarlyPurchase[],
) {
	return {
		invoiceId: invoice.id,
		invoiceNumber: invoice.number,
		status: invoice.status,
		dueDate: invoice.due_date
			? new Date(invoice.due_date * 1000).toISOString()
			: null,
		customerEmail: maskEmail(invoiceCustomerEmail(invoice)),
		accessProvisioning: invoice.metadata?.accessProvisioning,
		purchaseIds: purchases.map((p) => p.id),
		purchaseStatuses: purchases.map((p) => p.status),
	}
}

export function assertGrantable(invoice: Stripe.Invoice) {
	if (invoice.status !== 'open' || invoice.amount_paid !== 0)
		throw new Error(
			`Invoice ${invoice.id} is ${invoice.status}, paid ${invoice.amount_paid}; only an unpaid OPEN invoice can receive early access`,
		)
	if (invoice.metadata?.accessProvisioning !== AUTOMATIC_ACCESS)
		throw new Error(
			`Invoice ${invoice.id} does not use automatic team invoice provisioning`,
		)
	if (invoice.subscription || invoice.lines.has_more)
		throw new Error('Subscription or paginated invoice lines are not supported')
	const lines = invoice.lines.data.filter(
		(line) => line.price?.product && line.amount > 0,
	)
	if (
		lines.length !== 1 ||
		!Number.isInteger(lines[0]!.quantity) ||
		lines[0]!.quantity! < 1
	)
		throw new Error(
			'Exactly one positive product line with a positive seat count is required',
		)
	if (!invoiceCustomerEmail(invoice))
		throw new Error('Invoice has no customer email')
}

export function grantMetadata(grantedAt: string, purchaseId?: string) {
	return {
		accessProvisioning: EARLY_ACCESS,
		earlyAccessGrantedAt: grantedAt,
		...(purchaseId ? { earlyAccessPurchaseId: purchaseId } : {}),
	}
}

export function needsReview(invoice: Stripe.Invoice, now = Date.now()) {
	return (
		invoice.metadata?.accessProvisioning === EARLY_ACCESS &&
		(invoice.status === 'void' ||
			invoice.status === 'uncollectible' ||
			(invoice.status === 'open' &&
				invoice.due_date !== null &&
				invoice.due_date * 1000 < now))
	)
}

// State sketch: eligible -> marked -> purchased -> notified -> reconciled.
// A failure after marking stays manual (payment cannot fulfill it). Re-run
// resumes from the deterministic purchase, never restores automatic access.
// Stripe and MySQL cannot commit together. A late payment-path race is surfaced
// as DOUBLE rather than silently adopted; ops decides which access to retain.
export async function grantEarlyAccess(
	ports: EarlyAccessPorts,
	id: string,
	apply = false,
) {
	return ports.lock(id, async () => {
		const invoice = await ports.invoice(id)
		const existing = await ports.purchases(id)
		const early = existing.find((p) => p.fields?.earlyAccess === true)
		if (existing.length > 1)
			throw new Error(`DOUBLE: multiple purchases reference ${id}`)
		if (early) {
			if (
				invoice.metadata?.accessProvisioning !== EARLY_ACCESS ||
				(invoice.metadata.earlyAccessPurchaseId &&
					early.id !== invoice.metadata.earlyAccessPurchaseId)
			)
				throw new Error(
					'Grant metadata and purchase disagree; operator review required',
				)
			if (!invoice.metadata.earlyAccessPurchaseId) {
				if (
					!invoice.metadata.earlyAccessGrantedAt ||
					early.fields?.earlyAccessGrantedAt !==
						invoice.metadata.earlyAccessGrantedAt
				)
					throw new Error(
						'Grant metadata and purchase disagree; operator review required',
					)
				if (!apply)
					return {
						state: 'repair_ready',
						dryRun: true,
						...invoiceReadback(invoice, existing),
					}
				await ports.mark(
					id,
					grantMetadata(invoice.metadata.earlyAccessGrantedAt, early.id),
				)
			}
			if (apply && early.status === 'Valid') await ports.notify(invoice, early)
			return {
				state: 'already_granted',
				dryRun: !apply,
				...invoiceReadback(await ports.invoice(id), existing),
			}
		}
		if (existing.length)
			throw new Error('Invoice already has a purchase; refusing early access')
		// Recover only our marked-but-not-yet-purchased state. Never create new
		// access after payment/void even if the initial grant was interrupted.
		const pending =
			invoice.metadata?.accessProvisioning === EARLY_ACCESS &&
			Boolean(invoice.metadata.earlyAccessGrantedAt) &&
			!invoice.metadata.earlyAccessPurchaseId
		assertGrantable(
			pending
				? {
						...invoice,
						metadata: {
							...invoice.metadata,
							accessProvisioning: AUTOMATIC_ACCESS,
						},
					}
				: invoice,
		)
		if (!apply)
			return {
				state: pending ? 'resume_ready' : 'ready',
				dryRun: true,
				...invoiceReadback(invoice, []),
			}
		const grantedAt =
			invoice.metadata?.earlyAccessGrantedAt || new Date().toISOString()
		await ports.mark(id, grantMetadata(grantedAt))
		const marked = await ports.invoice(id)
		if (
			marked.status !== 'open' ||
			marked.amount_paid !== 0 ||
			marked.metadata?.accessProvisioning !== EARLY_ACCESS
		)
			throw new Error(
				'Invoice changed during marking; manual review required before access',
			)
		const purchase = await ports.create(marked, grantedAt)
		await ports.mark(id, grantMetadata(grantedAt, purchase.id))
		const readback = await ports.invoice(id)
		const after = await ports.purchases(id)
		if (after.length !== 1 || after[0]?.id !== purchase.id)
			throw new Error(
				`DOUBLE: grant/payment overlap for ${id}; operator review required`,
			)
		if (readback.metadata?.earlyAccessPurchaseId !== purchase.id)
			throw new Error(
				'Grant purchase exists but invoice metadata readback failed; operator review required',
			)
		await ports.notify(readback, purchase)
		return {
			state: 'granted',
			dryRun: false,
			...invoiceReadback(readback, after),
		}
	})
}

export async function revokeEarlyAccess(
	ports: EarlyAccessPorts,
	id: string,
	apply = false,
) {
	return ports.lock(id, async () => {
		const invoice = await ports.invoice(id)
		const purchases = await ports.purchases(id)
		const purchase = purchases[0]
		if (invoice.status === 'paid' || invoice.amount_paid > 0)
			throw new Error('Invoice is paid; use the normal refund workflow instead')
		if (
			invoice.metadata?.accessProvisioning !== EARLY_ACCESS ||
			purchases.length !== 1 ||
			!purchase ||
			purchase.fields?.earlyAccess !== true ||
			invoice.metadata.earlyAccessPurchaseId !== purchase.id
		)
			throw new Error('No unambiguous early-access grant to revoke')
		if (!['Valid', 'Refunded'].includes(purchase.status))
			throw new Error('Purchase status requires operator review')
		if (apply) await ports.revoke(purchase)
		return {
			state: apply ? 'revoke_requested' : 'revoke_ready',
			dryRun: !apply,
			...invoiceReadback(await ports.invoice(id), await ports.purchases(id)),
		}
	})
}
