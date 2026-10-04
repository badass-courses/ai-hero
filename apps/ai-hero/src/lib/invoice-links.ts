import 'server-only'
import {
	createInvoiceLinkToken,
	invoiceLinkTtlDays,
	invoiceLinkSecretUsable,
	parseInvoiceLinkToken,
	verifyInvoiceLinkToken,
} from '@/lib/invoice-link-token'
import { invoicePath } from '@/lib/invoice-paths'
import {
	drizzleInvoiceSettingsDataSource,
	type InvoiceSettingsDataSource,
} from '@/lib/invoice-settings'
import { canViewPurchaseInvoice } from '@/lib/team-purchases'

export type InvoiceLinkDataSource = Pick<
	InvoiceSettingsDataSource,
	'loadPurchaseByMerchantChargeId' | 'loadManagedTeamPurchases'
> & {
	loadVersion(purchaseId: string, merchantChargeId: string): Promise<number>
	rotateVersion(purchaseId: string, merchantChargeId: string): Promise<number>
}
export type InvoiceLinkConfiguration = { secret?: string; ttlDays?: string }
export type InvoiceLinkResult =
	| { state: 'minted'; invoicePath: string }
	| { state: 'denied' | 'not_found' | 'unavailable'; error: string }
type ViewerRequest = {
	merchantChargeId: string
	viewerUserId: string | null | undefined
}

export function invoiceLinkConfiguration(): InvoiceLinkConfiguration {
	return {
		secret: process.env.INVOICE_LINK_SECRET,
		ttlDays: process.env.INVOICE_LINK_TTL_DAYS,
	}
}

function configured(config: InvoiceLinkConfiguration): boolean {
	if (!invoiceLinkSecretUsable(config.secret)) return false
	try {
		return Number.isSafeInteger(
			Math.floor(Date.now() / 1000) +
				invoiceLinkTtlDays(config.ttlDays) * 86400,
		)
	} catch {
		return false
	}
}
const unavailable = (): InvoiceLinkResult => ({
	state: 'unavailable',
	error: 'Invoice sharing is not configured',
})
const denied = (): InvoiceLinkResult => ({
	state: 'denied',
	error: 'Not authorized to share this invoice',
})

function minted(
	merchantChargeId: string,
	linkVersion: number,
	config: InvoiceLinkConfiguration,
): InvoiceLinkResult {
	const token = createInvoiceLinkToken({
		chargeId: merchantChargeId,
		linkVersion,
		secret: config.secret,
		ttlDays: config.ttlDays,
	})
	return {
		state: 'minted',
		invoicePath: `${invoicePath(merchantChargeId)}?t=${token}`,
	}
}

/** Support authentication belongs to the HMAC-signed POST route. Mint is read-only. */
export async function mintSupportInvoiceLink(
	{ merchantChargeId }: { merchantChargeId: string },
	dataSource: InvoiceLinkDataSource = drizzleInvoiceLinkDataSource,
	config: InvoiceLinkConfiguration = invoiceLinkConfiguration(),
): Promise<InvoiceLinkResult> {
	if (!configured(config)) return unavailable()
	const purchase =
		await dataSource.loadPurchaseByMerchantChargeId(merchantChargeId)
	if (!purchase || purchase.merchantChargeId !== merchantChargeId) {
		return { state: 'not_found', error: 'Invoice not found' }
	}
	return minted(
		merchantChargeId,
		await dataSource.loadVersion(purchase.id, merchantChargeId),
		config,
	)
}

/** Check cryptography before DB access, then bind to the persisted counter. */
export async function validateInvoiceLinkAccess(
	{ merchantChargeId, token }: { merchantChargeId: string; token: unknown },
	dataSource: InvoiceLinkDataSource = drizzleInvoiceLinkDataSource,
	config: InvoiceLinkConfiguration = invoiceLinkConfiguration(),
): Promise<{ valid: false } | { valid: true; expiresAt: number }> {
	const parsed = parseInvoiceLinkToken(token)
	if (
		!parsed ||
		!verifyInvoiceLinkToken({
			token,
			chargeId: merchantChargeId,
			linkVersion: parsed.linkVersion,
			secret: config.secret,
		})
	)
		return { valid: false }
	const purchase =
		await dataSource.loadPurchaseByMerchantChargeId(merchantChargeId)
	if (!purchase || purchase.merchantChargeId !== merchantChargeId)
		return { valid: false }
	const linkVersion = await dataSource.loadVersion(
		purchase.id,
		merchantChargeId,
	)
	return verifyInvoiceLinkToken({
		token,
		chargeId: merchantChargeId,
		linkVersion,
		secret: config.secret,
	})
		? { valid: true, expiresAt: parsed.expiresAt }
		: { valid: false }
}

async function forViewer(
	{ merchantChargeId, viewerUserId }: ViewerRequest,
	rotate: boolean,
	dataSource: InvoiceLinkDataSource,
	config: InvoiceLinkConfiguration,
): Promise<InvoiceLinkResult> {
	if (!viewerUserId) return denied()
	if (!configured(config)) return unavailable()
	const purchase =
		await dataSource.loadPurchaseByMerchantChargeId(merchantChargeId)
	if (!purchase || purchase.merchantChargeId !== merchantChargeId) {
		return { state: 'not_found', error: 'Invoice not found' }
	}
	const managed = await dataSource.loadManagedTeamPurchases(viewerUserId)
	if (!canViewPurchaseInvoice(viewerUserId, purchase, managed)) return denied()
	const version = rotate
		? await dataSource.rotateVersion(purchase.id, merchantChargeId)
		: await dataSource.loadVersion(purchase.id, merchantChargeId)
	return minted(merchantChargeId, version, config)
}

export async function mintInvoiceLinkForViewer(
	input: ViewerRequest,
	dataSource: InvoiceLinkDataSource = drizzleInvoiceLinkDataSource,
	config: InvoiceLinkConfiguration = invoiceLinkConfiguration(),
): Promise<InvoiceLinkResult> {
	return forViewer(input, false, dataSource, config)
}
export async function rotateInvoiceLinkForViewer(
	input: ViewerRequest,
	dataSource: InvoiceLinkDataSource = drizzleInvoiceLinkDataSource,
	config: InvoiceLinkConfiguration = invoiceLinkConfiguration(),
): Promise<InvoiceLinkResult> {
	return forViewer(input, true, dataSource, config)
}

export const drizzleInvoiceLinkDataSource: InvoiceLinkDataSource = {
	loadPurchaseByMerchantChargeId: (id) =>
		drizzleInvoiceSettingsDataSource.loadPurchaseByMerchantChargeId(id),
	loadManagedTeamPurchases: (id) =>
		drizzleInvoiceSettingsDataSource.loadManagedTeamPurchases(id),
	async loadVersion(purchaseId, merchantChargeId) {
		const { db } = await import('@/db')
		const { invoiceSettings } = await import('@/db/schema')
		const { and, eq } = await import('drizzle-orm')
		const row = await db.query.invoiceSettings.findFirst({
			where: and(
				eq(invoiceSettings.purchaseId, purchaseId),
				eq(invoiceSettings.merchantChargeId, merchantChargeId),
			),
			columns: { linkVersion: true },
		})
		// Missing details rows have never been rotated. Existing rows must carry
		// the migrated version, not silently fall back to bare or version-1 access.
		return row ? row.linkVersion : 1
	},
	async rotateVersion(purchaseId, merchantChargeId) {
		const { db } = await import('@/db')
		const { invoiceSettings } = await import('@/db/schema')
		const { and, eq, sql } = await import('drizzle-orm')
		return db.transaction(async (tx) => {
			// An absent settings row starts at version 1, so its first rotation
			// must insert version 2. Atomic upsert locks existing rows; readback
			// in the same transaction cannot observe a concurrent rotation.
			await tx
				.insert(invoiceSettings)
				.values({ purchaseId, merchantChargeId, linkVersion: 2 })
				.onDuplicateKeyUpdate({
					set: { linkVersion: sql`${invoiceSettings.linkVersion} + 1` },
				})
			const row = await tx.query.invoiceSettings.findFirst({
				where: and(
					eq(invoiceSettings.purchaseId, purchaseId),
					eq(invoiceSettings.merchantChargeId, merchantChargeId),
				),
				columns: { linkVersion: true },
			})
			if (!row || !Number.isInteger(row.linkVersion) || row.linkVersion < 2) {
				throw new Error('Invoice link rotation could not be verified')
			}
			return row.linkVersion
		})
	},
}
