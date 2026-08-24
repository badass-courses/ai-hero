import { createHash } from 'crypto'
import { invoicePath } from '@/lib/invoice-paths'
import {
	canViewPurchaseInvoice,
	getTeamPurchasesForMember,
} from '@/lib/team-purchases'
import { z } from 'zod'

import { guid } from '@coursebuilder/utils/guid'

/**
 * Server-persisted invoice details (AIH-259).
 *
 * The invoice page used to keep the recipient name and notes in browser
 * localStorage, so they vanished across devices and could not be prefilled by
 * support. This module owns the durable replacement: validation, authorization
 * (purchase owner or team manager), persistence keyed by purchase and
 * merchant charge, and the guarded support prefill seam with audit receipts.
 *
 * These values are billing details. Never put them in URLs, logs, analytics,
 * or audit receipts. Log only the presence summary from
 * {@link describeInvoiceSettingsForLog}.
 */

const optionalTrimmed = (max: number) =>
	z
		.string()
		.max(max)
		.transform((value) => value.trim())
		.optional()

export const invoiceSettingsInputSchema = z.object({
	recipientName: optionalTrimmed(255),
	companyName: optionalTrimmed(255),
	address: optionalTrimmed(1000),
	taxId: optionalTrimmed(100),
	notes: optionalTrimmed(2000),
})

export type InvoiceSettingsInput = z.infer<typeof invoiceSettingsInputSchema>

export type InvoiceSettings = {
	purchaseId: string
	merchantChargeId: string
	recipientName: string | null
	companyName: string | null
	address: string | null
	taxId: string | null
	notes: string | null
	source: 'owner' | 'support'
	/** App user who saved (owner/manager path). Never a support operator. */
	updatedByUserId: string | null
	/** Support operator who prefilled. Operators are not app users. */
	supportOperatorId: string | null
}

/**
 * Audit metadata a support prefill must carry inside the signed request
 * body. All of it is persisted into the mutation receipt; none of it is a
 * billing value.
 */
export type SupportPrefillAudit = {
	runId: string
	conversationId: string
	operatorId: string
	approvalReference: string
	expectedInboundId: string
	/** Caller-computed {@link computeInvoiceSettingsInputHash} of the settings. */
	inputHash: string
}

export type SupportPrefillOutcome =
	| 'prefilled'
	| 'replayed'
	| 'readback_mismatch'
	| 'input_hash_mismatch'
	| 'purchase_charge_mismatch'

/** Redacted audit receipt row. Identifiers and outcome only, never values. */
export type SupportPrefillReceipt = {
	id: string
	purchaseId: string
	merchantChargeId: string
	runId: string
	conversationId: string
	operatorId: string
	approvalReference: string
	expectedInboundId: string
	inputHash: string
	/**
	 * {@link computeSupportPrefillRequestKey} of the signed request. Set only
	 * on `prefilled` receipts, where a unique index makes it the atomic replay
	 * guard: an exact replay of an applied request cannot claim a second
	 * success receipt, so it cannot write settings either. Null on every
	 * other outcome so guard failures and rolled-back writes stay retryable.
	 */
	requestKey: string | null
	outcome: SupportPrefillOutcome
	readbackMatched: boolean | null
}

export type InvoiceSettingsDataSource = {
	loadPurchaseByMerchantChargeId(merchantChargeId: string): Promise<{
		id: string
		userId: string | null
		merchantChargeId: string | null
	} | null>
	loadSettings(
		purchaseId: string,
		merchantChargeId: string,
	): Promise<InvoiceSettings | null>
	loadManagedTeamPurchases(viewerUserId: string): Promise<{ id: string }[]>
	/**
	 * Persist a receipt outside any settings transaction. Used for guard
	 * failures, replays, and a readback mismatch after its write was rolled
	 * back.
	 */
	insertSupportReceipt(receipt: SupportPrefillReceipt): Promise<void>
	/**
	 * The `prefilled` receipt that already claimed this request key, if any.
	 * A cheap pre-check that gives replays a stable answer; the unique index
	 * inside {@link commitVerifiedSettings} is the guard that actually holds
	 * under concurrency.
	 */
	findPrefilledReceiptByRequestKey(
		requestKey: string,
	): Promise<SupportPrefillReceipt | null>
	/**
	 * The only write path for settings. Upserts, reads back, and commits only
	 * when the readback matches what was written. On mismatch the write is
	 * rolled back so no unverified values persist. When `successReceipt` is
	 * given it is inserted in the same transaction, BEFORE the settings
	 * upsert, so its unique `requestKey` is claimed atomically with the
	 * write: a duplicate key means the exact request was already applied,
	 * the transaction is abandoned without touching settings, and the result
	 * is `{ verified: false, replay: true }`.
	 */
	commitVerifiedSettings(
		settings: InvoiceSettings,
		successReceipt?: SupportPrefillReceipt,
	): Promise<CommitVerifiedSettingsResult>
}

export type CommitVerifiedSettingsResult =
	| {
			verified: true
			readback: InvoiceSettings
			receipt: SupportPrefillReceipt | null
	  }
	| { verified: false; replay: false; readback: InvoiceSettings | null }
	| { verified: false; replay: true }

export type SaveInvoiceSettingsResult =
	| { state: 'saved'; settings: InvoiceSettings }
	| {
			state: 'denied' | 'not_found' | 'invalid' | 'readback_mismatch'
			error: string
	  }

function normalize(value: string | undefined): string | null {
	if (!value) return null
	const trimmed = value.trim()
	return trimmed === '' ? null : trimmed
}

function toStoredShape(
	purchaseId: string,
	merchantChargeId: string,
	input: InvoiceSettingsInput,
	attribution:
		| { source: 'owner'; updatedByUserId: string }
		| { source: 'support'; supportOperatorId: string },
): InvoiceSettings {
	return {
		purchaseId,
		merchantChargeId,
		recipientName: normalize(input.recipientName),
		companyName: normalize(input.companyName),
		address: normalize(input.address),
		taxId: normalize(input.taxId),
		notes: normalize(input.notes),
		source: attribution.source,
		updatedByUserId:
			attribution.source === 'owner' ? attribution.updatedByUserId : null,
		supportOperatorId:
			attribution.source === 'support' ? attribution.supportOperatorId : null,
	}
}

const VALUE_FIELDS = [
	'recipientName',
	'companyName',
	'address',
	'taxId',
	'notes',
] as const

export function settingsValuesMatch(
	a: InvoiceSettings,
	b: InvoiceSettings,
): boolean {
	return VALUE_FIELDS.every((field) => a[field] === b[field])
}

/**
 * Deterministic canonical hash of normalized invoice settings: sha256 hex of
 * the JSON array [recipientName, companyName, address, taxId, notes] after
 * trimming and empty-to-null normalization. The support platform computes
 * this over the exact customer-approved values and sends it inside the
 * signed body; the server recomputes it from the received settings and
 * refuses to write on mismatch.
 */
export function computeInvoiceSettingsInputHash(
	input: InvoiceSettingsInput,
): string {
	const canonical = JSON.stringify([
		normalize(input.recipientName),
		normalize(input.companyName),
		normalize(input.address),
		normalize(input.taxId),
		normalize(input.notes),
	])
	return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Deterministic key for one exact signed support prefill request: sha256 hex
 * of the JSON array [version, purchaseId, merchantChargeId, runId,
 * conversationId, operatorId, approvalReference, expectedInboundId,
 * inputHash]. `inputHash` alone only binds the settings values, and `runId`
 * alone is too coarse because one support run can prefill several
 * conversations; this key binds the purchase, the charge, every audit field,
 * and (through the verified `inputHash`) the settings values. The same body
 * re-signed with a fresh timestamp inside the five-minute HMAC window yields
 * the same key, which is the point: it is the same request.
 */
export function computeSupportPrefillRequestKey({
	purchaseId,
	merchantChargeId,
	audit,
}: {
	purchaseId: string
	merchantChargeId: string
	audit: SupportPrefillAudit
}): string {
	const canonical = JSON.stringify([
		'support-invoice-prefill.v1',
		purchaseId,
		merchantChargeId,
		audit.runId,
		audit.conversationId,
		audit.operatorId,
		audit.approvalReference,
		audit.expectedInboundId,
		audit.inputHash,
	])
	return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Safe-to-log presence summary. Contains no billing values, only which
 * fields are set.
 */
export function describeInvoiceSettingsForLog(settings: InvoiceSettings) {
	return {
		purchaseId: settings.purchaseId,
		merchantChargeId: settings.merchantChargeId,
		source: settings.source,
		fieldsSet: VALUE_FIELDS.filter((field) => settings[field] !== null),
	}
}

/**
 * Save invoice settings on behalf of a signed-in viewer. Authorization matches
 * invoice viewing: the purchase owner or a manager of the team purchase.
 * Persists, reads back, and only reports success when the readback matches.
 */
export async function saveInvoiceSettingsForViewer(
	{
		merchantChargeId,
		viewerUserId,
		input,
	}: {
		merchantChargeId: string
		viewerUserId: string | null | undefined
		input: unknown
	},
	dataSource: InvoiceSettingsDataSource,
): Promise<SaveInvoiceSettingsResult> {
	if (!viewerUserId) {
		return { state: 'denied', error: 'Sign in to edit this invoice' }
	}

	const parsed = invoiceSettingsInputSchema.safeParse(input)
	if (!parsed.success) {
		return { state: 'invalid', error: 'Invalid invoice details' }
	}

	const purchase =
		await dataSource.loadPurchaseByMerchantChargeId(merchantChargeId)
	if (!purchase) {
		return { state: 'not_found', error: 'Purchase not found' }
	}

	const managedTeamPurchases =
		await dataSource.loadManagedTeamPurchases(viewerUserId)
	if (
		!canViewPurchaseInvoice(
			viewerUserId,
			{ id: purchase.id, userId: purchase.userId },
			managedTeamPurchases,
		)
	) {
		return { state: 'denied', error: 'Not authorized to edit this invoice' }
	}

	const next = toStoredShape(purchase.id, merchantChargeId, parsed.data, {
		source: 'owner',
		updatedByUserId: viewerUserId,
	})
	const committed = await dataSource.commitVerifiedSettings(next)
	if (!committed.verified) {
		return {
			state: 'readback_mismatch',
			error: 'Saved values could not be verified',
		}
	}

	return { state: 'saved', settings: committed.readback }
}

export type SupportPrefillResult =
	| {
			state: 'prefilled'
			settings: InvoiceSettings
			invoicePath: string
			receipt: SupportPrefillReceipt
	  }
	| { state: 'not_found' | 'invalid'; error: string }
	| {
			state:
				| 'readback_mismatch'
				| 'input_hash_mismatch'
				| 'purchase_charge_mismatch'
			error: string
			receipt: SupportPrefillReceipt
	  }
	| {
			/**
			 * The exact signed request was already applied. Settings were not
			 * touched (a newer owner or support save wins) and no second
			 * `prefilled` receipt exists; `originalReceiptId` names the first.
			 */
			state: 'replayed'
			error: string
			receipt: SupportPrefillReceipt
			originalReceiptId: string | null
	  }

/**
 * Support prefill seam. Caller identity is established by the HMAC-signed
 * route, not here. The caller must name both the purchase and the merchant
 * charge; the write only happens when both agree with the stored purchase
 * and the caller-supplied input hash matches the server-computed canonical
 * hash. Persists the settings, reads them back, and only returns the direct
 * invoice link once the readback matches what was requested. An exact replay
 * of an already-applied request (same purchase, charge, audit block, and
 * settings hash) is refused without touching settings, so a re-delivered
 * request inside the HMAC window cannot overwrite newer values. Every attempt
 * that reached a resolved purchase leaves a redacted audit receipt. The
 * link carries only the merchant charge id, never billing values.
 */
export async function applySupportInvoicePrefill(
	{
		purchaseId,
		merchantChargeId,
		input,
		audit,
	}: {
		purchaseId: string
		merchantChargeId: string
		input: unknown
		audit: SupportPrefillAudit
	},
	dataSource: InvoiceSettingsDataSource,
): Promise<SupportPrefillResult> {
	const parsed = invoiceSettingsInputSchema.safeParse(input)
	if (!parsed.success) {
		return { state: 'invalid', error: 'Invalid invoice details' }
	}

	const purchase =
		await dataSource.loadPurchaseByMerchantChargeId(merchantChargeId)
	if (!purchase) {
		return { state: 'not_found', error: 'Purchase not found' }
	}

	const baseReceipt = {
		purchaseId,
		merchantChargeId,
		runId: audit.runId,
		conversationId: audit.conversationId,
		operatorId: audit.operatorId,
		approvalReference: audit.approvalReference,
		expectedInboundId: audit.expectedInboundId,
		inputHash: audit.inputHash,
		requestKey: null,
	}

	if (
		purchase.id !== purchaseId ||
		purchase.merchantChargeId !== merchantChargeId
	) {
		const receipt: SupportPrefillReceipt = {
			id: `sipr_${guid()}`,
			...baseReceipt,
			outcome: 'purchase_charge_mismatch',
			readbackMatched: null,
		}
		await dataSource.insertSupportReceipt(receipt)
		return {
			state: 'purchase_charge_mismatch',
			error: 'Purchase and merchant charge do not agree',
			receipt,
		}
	}

	const computedHash = computeInvoiceSettingsInputHash(parsed.data)
	if (computedHash !== audit.inputHash) {
		const receipt: SupportPrefillReceipt = {
			id: `sipr_${guid()}`,
			...baseReceipt,
			outcome: 'input_hash_mismatch',
			readbackMatched: null,
		}
		await dataSource.insertSupportReceipt(receipt)
		return {
			state: 'input_hash_mismatch',
			error: 'Input hash does not match the received settings',
			receipt,
		}
	}

	const requestKey = computeSupportPrefillRequestKey({
		purchaseId,
		merchantChargeId,
		audit,
	})

	const replayed = async (
		originalReceiptId: string | null,
	): Promise<SupportPrefillResult> => {
		const receipt: SupportPrefillReceipt = {
			id: `sipr_${guid()}`,
			...baseReceipt,
			outcome: 'replayed',
			readbackMatched: null,
		}
		await dataSource.insertSupportReceipt(receipt)
		return {
			state: 'replayed',
			error: 'This request was already applied',
			receipt,
			originalReceiptId,
		}
	}

	const alreadyApplied =
		await dataSource.findPrefilledReceiptByRequestKey(requestKey)
	if (alreadyApplied) {
		return replayed(alreadyApplied.id)
	}

	const next = toStoredShape(purchase.id, merchantChargeId, parsed.data, {
		source: 'support',
		supportOperatorId: audit.operatorId,
	})

	const committed = await dataSource.commitVerifiedSettings(next, {
		id: `sipr_${guid()}`,
		...baseReceipt,
		requestKey,
		outcome: 'prefilled',
		readbackMatched: true,
	})

	if (!committed.verified && committed.replay) {
		// Lost the race to an identical request that committed between the
		// pre-check and our claim. The unique index refused the second success
		// receipt, so nothing of ours was written.
		const original =
			await dataSource.findPrefilledReceiptByRequestKey(requestKey)
		return replayed(original?.id ?? null)
	}

	if (!committed.verified) {
		// The settings write was rolled back; the receipt must still land, so
		// it is written outside that transaction.
		const receipt: SupportPrefillReceipt = {
			id: `sipr_${guid()}`,
			...baseReceipt,
			outcome: 'readback_mismatch',
			readbackMatched: false,
		}
		await dataSource.insertSupportReceipt(receipt)
		return {
			state: 'readback_mismatch',
			error: 'Prefill could not be verified, no link issued',
			receipt,
		}
	}

	if (!committed.receipt) {
		throw new Error('Support prefill committed without a receipt')
	}

	return {
		state: 'prefilled',
		settings: committed.readback,
		invoicePath: invoicePath(merchantChargeId),
		receipt: committed.receipt,
	}
}

/** Thrown inside the write transaction to force a rollback on mismatch. */
class ReadbackMismatchRollback extends Error {
	constructor(readonly readback: InvoiceSettings | null) {
		super('Invoice settings readback mismatch')
	}
}

export const SUPPORT_PREFILL_REQUEST_KEY_INDEX = 'sipr_request_key_uidx'

type MysqlErrorLike = {
	cause?: unknown
	code?: unknown
	errno?: unknown
	message?: unknown
	sqlMessage?: unknown
}

/**
 * True when `error` (or anything in its `cause` chain) is a MySQL duplicate
 * key error on the receipt request-key unique index. Any other duplicate
 * (for example a PRIMARY collision) is not a replay and must propagate.
 */
export function isSupportPrefillRequestKeyCollision(error: unknown): boolean {
	let current: unknown = error
	for (
		let depth = 0;
		depth < 5 && current && typeof current === 'object';
		depth++
	) {
		const candidate = current as MysqlErrorLike
		const isDuplicate =
			candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062
		const message = [candidate.message, candidate.sqlMessage]
			.filter((value): value is string => typeof value === 'string')
			.join(' ')
		if (isDuplicate && message.includes(SUPPORT_PREFILL_REQUEST_KEY_INDEX)) {
			return true
		}
		current = candidate.cause
	}
	return false
}

function rowToSettings(row: {
	purchaseId: string
	merchantChargeId: string
	recipientName: string | null
	companyName: string | null
	address: string | null
	taxId: string | null
	notes: string | null
	source: string
	updatedByUserId: string | null
	supportOperatorId: string | null
}): InvoiceSettings {
	return {
		purchaseId: row.purchaseId,
		merchantChargeId: row.merchantChargeId,
		recipientName: row.recipientName,
		companyName: row.companyName,
		address: row.address,
		taxId: row.taxId,
		notes: row.notes,
		source: row.source === 'support' ? 'support' : 'owner',
		updatedByUserId: row.updatedByUserId,
		supportOperatorId: row.supportOperatorId,
	}
}

function rowToReceipt(row: {
	id: string
	purchaseId: string
	merchantChargeId: string
	runId: string
	conversationId: string
	operatorId: string
	approvalReference: string
	expectedInboundId: string
	inputHash: string
	requestKey: string | null
	outcome: string
	readbackMatched: boolean | null
}): SupportPrefillReceipt {
	return {
		id: row.id,
		purchaseId: row.purchaseId,
		merchantChargeId: row.merchantChargeId,
		runId: row.runId,
		conversationId: row.conversationId,
		operatorId: row.operatorId,
		approvalReference: row.approvalReference,
		expectedInboundId: row.expectedInboundId,
		inputHash: row.inputHash,
		requestKey: row.requestKey,
		outcome: row.outcome as SupportPrefillOutcome,
		readbackMatched: row.readbackMatched,
	}
}

function settingsToRow(settings: InvoiceSettings) {
	return {
		purchaseId: settings.purchaseId,
		merchantChargeId: settings.merchantChargeId,
		recipientName: settings.recipientName,
		companyName: settings.companyName,
		address: settings.address,
		taxId: settings.taxId,
		notes: settings.notes,
		source: settings.source,
		updatedByUserId: settings.updatedByUserId,
		supportOperatorId: settings.supportOperatorId,
	}
}

export const drizzleInvoiceSettingsDataSource: InvoiceSettingsDataSource = {
	async loadPurchaseByMerchantChargeId(merchantChargeId) {
		const { db } = await import('@/db')
		const { purchases } = await import('@/db/schema')
		const { eq } = await import('drizzle-orm')
		const purchase = await db.query.purchases.findFirst({
			where: eq(purchases.merchantChargeId, merchantChargeId),
			columns: { id: true, userId: true, merchantChargeId: true },
		})
		return purchase
			? {
					id: purchase.id,
					userId: purchase.userId,
					merchantChargeId: purchase.merchantChargeId,
				}
			: null
	},

	async loadSettings(purchaseId, merchantChargeId) {
		const { db } = await import('@/db')
		const { invoiceSettings } = await import('@/db/schema')
		const { and, eq } = await import('drizzle-orm')
		const row = await db.query.invoiceSettings.findFirst({
			where: and(
				eq(invoiceSettings.purchaseId, purchaseId),
				eq(invoiceSettings.merchantChargeId, merchantChargeId),
			),
		})
		return row ? rowToSettings(row) : null
	},

	async loadManagedTeamPurchases(viewerUserId) {
		const managed = await getTeamPurchasesForMember(viewerUserId)
		return managed.map((purchase) => ({ id: purchase.id }))
	},

	async insertSupportReceipt(receipt) {
		const { db } = await import('@/db')
		const { supportInvoicePrefillReceipts } = await import('@/db/schema')
		await db.insert(supportInvoicePrefillReceipts).values(receipt)
	},

	async findPrefilledReceiptByRequestKey(requestKey) {
		const { db } = await import('@/db')
		const { supportInvoicePrefillReceipts } = await import('@/db/schema')
		const { and, eq } = await import('drizzle-orm')
		const row = await db.query.supportInvoicePrefillReceipts.findFirst({
			where: and(
				eq(supportInvoicePrefillReceipts.requestKey, requestKey),
				eq(supportInvoicePrefillReceipts.outcome, 'prefilled'),
			),
		})
		return row ? rowToReceipt(row) : null
	},

	async commitVerifiedSettings(settings, successReceipt) {
		const { db } = await import('@/db')
		const { invoiceSettings, supportInvoicePrefillReceipts } =
			await import('@/db/schema')
		const { and, eq } = await import('drizzle-orm')
		const values = settingsToRow(settings)
		try {
			return await db.transaction(
				async (tx): Promise<CommitVerifiedSettingsResult> => {
					// Claim the request key first. A duplicate aborts the transaction
					// before the settings upsert runs; a later readback mismatch rolls
					// the claim back with the write so an honest retry is allowed.
					if (successReceipt) {
						await tx
							.insert(supportInvoicePrefillReceipts)
							.values(successReceipt)
					}
					await tx
						.insert(invoiceSettings)
						.values(values)
						.onDuplicateKeyUpdate({
							set: {
								recipientName: values.recipientName,
								companyName: values.companyName,
								address: values.address,
								taxId: values.taxId,
								notes: values.notes,
								source: values.source,
								updatedByUserId: values.updatedByUserId,
								supportOperatorId: values.supportOperatorId,
							},
						})
					const row = await tx.query.invoiceSettings.findFirst({
						where: and(
							eq(invoiceSettings.purchaseId, settings.purchaseId),
							eq(invoiceSettings.merchantChargeId, settings.merchantChargeId),
						),
					})
					const readback = row ? rowToSettings(row) : null
					if (!readback || !settingsValuesMatch(settings, readback)) {
						throw new ReadbackMismatchRollback(readback)
					}
					return { verified: true, readback, receipt: successReceipt ?? null }
				},
			)
		} catch (error) {
			if (error instanceof ReadbackMismatchRollback) {
				return { verified: false, replay: false, readback: error.readback }
			}
			if (successReceipt && isSupportPrefillRequestKeyCollision(error)) {
				return { verified: false, replay: true }
			}
			throw error
		}
	},
}
