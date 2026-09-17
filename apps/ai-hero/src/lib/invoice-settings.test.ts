import { describe, expect, it } from 'vitest'

import {
	applySupportInvoicePrefill,
	computeInvoiceSettingsInputHash,
	computeSupportPrefillRequestKey,
	describeInvoiceSettingsForLog,
	isSupportPrefillRequestKeyCollision,
	saveInvoiceSettingsForViewer,
	settingsValuesMatch,
	SUPPORT_PREFILL_REQUEST_KEY_INDEX,
	type InvoiceSettings,
	type InvoiceSettingsDataSource,
	type SupportPrefillAudit,
	type SupportPrefillReceipt,
} from './invoice-settings'

type StoreOptions = {
	purchases?: { merchantChargeId: string; id: string; userId: string | null }[]
	managedPurchaseIds?: Record<string, string[]>
	corruptReadback?: boolean
	/**
	 * Simulate losing a race: the pre-check sees no prior success receipt, but
	 * the unique index inside the commit already holds the request key.
	 */
	hidePrefilledFromPrecheck?: boolean
}

function settingsKey(purchaseId: string, merchantChargeId: string) {
	return `${purchaseId}::${merchantChargeId}`
}

function memoryDataSource(options: StoreOptions = {}) {
	const rows = new Map<string, InvoiceSettings>()
	const receipts: SupportPrefillReceipt[] = []
	const dataSource: InvoiceSettingsDataSource = {
		async loadPurchaseByMerchantChargeId(merchantChargeId) {
			const purchase = options.purchases?.find(
				(p) => p.merchantChargeId === merchantChargeId,
			)
			return purchase
				? {
						id: purchase.id,
						userId: purchase.userId,
						merchantChargeId: purchase.merchantChargeId,
					}
				: null
		},
		async loadSettings(purchaseId, merchantChargeId) {
			const row = rows.get(settingsKey(purchaseId, merchantChargeId))
			if (!row) return null
			if (options.corruptReadback) {
				return { ...row, recipientName: 'someone else entirely' }
			}
			return row
		},
		async loadManagedTeamPurchases(viewerUserId) {
			return (options.managedPurchaseIds?.[viewerUserId] ?? []).map((id) => ({
				id,
			}))
		},
		async insertSupportReceipt(receipt) {
			receipts.push(receipt)
		},
		async findPrefilledReceiptByRequestKey(requestKey) {
			if (options.hidePrefilledFromPrecheck) return null
			return (
				receipts.find(
					(r) => r.outcome === 'prefilled' && r.requestKey === requestKey,
				) ?? null
			)
		},
		// Mirrors the drizzle transaction: the success receipt claims its
		// unique request key first (a duplicate abandons the call with nothing
		// written); the write only survives when the readback matches,
		// otherwise the prior row (or absence) is restored and the claim is
		// released.
		async commitVerifiedSettings(settings, successReceipt) {
			if (
				successReceipt?.requestKey &&
				receipts.some(
					(r) =>
						r.requestKey !== null && r.requestKey === successReceipt.requestKey,
				)
			) {
				return { verified: false, replay: true }
			}
			const key = settingsKey(settings.purchaseId, settings.merchantChargeId)
			const previous = rows.get(key)
			rows.set(key, settings)
			const readback = await this.loadSettings(
				settings.purchaseId,
				settings.merchantChargeId,
			)
			if (!readback || !settingsValuesMatch(settings, readback)) {
				if (previous) rows.set(key, previous)
				else rows.delete(key)
				return { verified: false, replay: false, readback }
			}
			if (successReceipt) receipts.push(successReceipt)
			return { verified: true, readback, receipt: successReceipt ?? null }
		},
	}
	return { dataSource, rows, receipts }
}

function existingOwnerRow(): InvoiceSettings {
	return {
		purchaseId: PURCHASE_ID,
		merchantChargeId: CHARGE,
		recipientName: 'Grace Hopper',
		companyName: null,
		address: null,
		taxId: null,
		notes: 'keep me',
		source: 'owner',
		updatedByUserId: OWNER,
		supportOperatorId: null,
	}
}

const OWNER = 'user_owner'
const CHARGE = 'mch_123'
const PURCHASE_ID = 'purchase_1'
const PURCHASES = [{ merchantChargeId: CHARGE, id: PURCHASE_ID, userId: OWNER }]

const INPUT = {
	recipientName: '  Ada Lovelace  ',
	companyName: 'Analytical Engines Ltd',
	address: '1 Example Way\nLondon',
	taxId: 'GB123456789',
	notes: 'PO 4711',
}

const BILLING_VALUES = [
	'Ada Lovelace',
	'Analytical Engines Ltd',
	'Example Way',
	'GB123456789',
	'PO 4711',
]

function audit(
	overrides: Partial<SupportPrefillAudit> = {},
): SupportPrefillAudit {
	return {
		runId: 'run_abc',
		conversationId: 'cnv_front_1',
		operatorId: 'operator_jane',
		approvalReference: 'approval_777',
		expectedInboundId: 'msg_inbound_9',
		inputHash: computeInvoiceSettingsInputHash(INPUT),
		...overrides,
	}
}

describe('saveInvoiceSettingsForViewer', () => {
	it('rejects anonymous viewers', async () => {
		const { dataSource, rows } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: null, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('denied')
		expect(rows.size).toBe(0)
	})

	it('rejects viewers who are neither owner nor team manager', async () => {
		const { dataSource, rows } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: 'user_stranger', input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('denied')
		expect(rows.size).toBe(0)
	})

	it('saves trimmed values for the purchase owner and verifies readback', async () => {
		const { dataSource } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: OWNER, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('saved')
		if (result.state !== 'saved') return
		expect(result.settings.recipientName).toBe('Ada Lovelace')
		expect(result.settings.companyName).toBe('Analytical Engines Ltd')
		expect(result.settings.taxId).toBe('GB123456789')
		expect(result.settings.merchantChargeId).toBe(CHARGE)
		expect(result.settings.source).toBe('owner')
		expect(result.settings.updatedByUserId).toBe(OWNER)
		expect(result.settings.supportOperatorId).toBeNull()
	})

	it('stores empty strings as null', async () => {
		const { dataSource, rows } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{
				merchantChargeId: CHARGE,
				viewerUserId: OWNER,
				input: { recipientName: 'Ada', companyName: '   ', notes: '' },
			},
			dataSource,
		)
		expect(result.state).toBe('saved')
		const row = rows.get(settingsKey(PURCHASE_ID, CHARGE))
		expect(row?.companyName).toBeNull()
		expect(row?.notes).toBeNull()
	})

	it('allows a team manager of the purchase', async () => {
		const { dataSource } = memoryDataSource({
			purchases: PURCHASES,
			managedPurchaseIds: { user_manager: ['purchase_1'] },
		})
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: 'user_manager', input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('saved')
	})

	it('rejects oversized input', async () => {
		const { dataSource, rows } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{
				merchantChargeId: CHARGE,
				viewerUserId: OWNER,
				input: { recipientName: 'x'.repeat(1000) },
			},
			dataSource,
		)
		expect(result.state).toBe('invalid')
		expect(rows.size).toBe(0)
	})

	it('returns not_found for an unknown charge', async () => {
		const { dataSource } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: 'mch_nope', viewerUserId: OWNER, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('not_found')
	})

	it('does not report success when readback differs from what was written', async () => {
		const { dataSource } = memoryDataSource({
			purchases: PURCHASES,
			corruptReadback: true,
		})
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: OWNER, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('readback_mismatch')
	})

	it('leaves no unverified row behind when readback fails on a first save', async () => {
		const { dataSource, rows } = memoryDataSource({
			purchases: PURCHASES,
			corruptReadback: true,
		})
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: OWNER, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('readback_mismatch')
		expect(rows.size).toBe(0)
	})

	it('keeps the previously verified row when readback fails on an update', async () => {
		const { dataSource, rows } = memoryDataSource({
			purchases: PURCHASES,
			corruptReadback: true,
		})
		rows.set(settingsKey(PURCHASE_ID, CHARGE), existingOwnerRow())
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: OWNER, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('readback_mismatch')
		expect(rows.get(settingsKey(PURCHASE_ID, CHARGE))).toEqual(
			existingOwnerRow(),
		)
	})
})

describe('computeInvoiceSettingsInputHash', () => {
	it('is deterministic over normalization, not formatting', () => {
		const padded = computeInvoiceSettingsInputHash({
			recipientName: '  Ada Lovelace  ',
			companyName: 'Analytical Engines Ltd',
			notes: '',
		})
		const clean = computeInvoiceSettingsInputHash({
			recipientName: 'Ada Lovelace',
			companyName: 'Analytical Engines Ltd',
		})
		expect(padded).toBe(clean)
		expect(padded).toMatch(/^[0-9a-f]{64}$/)
	})

	it('changes when any value changes', () => {
		const a = computeInvoiceSettingsInputHash({ taxId: 'GB123456789' })
		const b = computeInvoiceSettingsInputHash({ taxId: 'GB123456780' })
		expect(a).not.toBe(b)
	})
})

describe('applySupportInvoicePrefill', () => {
	it('persists, reads back, records a receipt, and returns a link with no billing values', async () => {
		const { dataSource, receipts } = memoryDataSource({ purchases: PURCHASES })
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		expect(result.state).toBe('prefilled')
		if (result.state !== 'prefilled') return
		expect(result.invoicePath).toBe(`/invoices/${CHARGE}`)
		expect(result.invoicePath).not.toContain('Ada')
		expect(result.invoicePath).not.toContain('GB123456789')
		expect(result.settings.source).toBe('support')
		expect(result.settings.updatedByUserId).toBeNull()
		expect(result.settings.supportOperatorId).toBe('operator_jane')
		expect(receipts).toHaveLength(1)
		expect(receipts[0]).toMatchObject({
			purchaseId: PURCHASE_ID,
			merchantChargeId: CHARGE,
			runId: 'run_abc',
			conversationId: 'cnv_front_1',
			operatorId: 'operator_jane',
			approvalReference: 'approval_777',
			expectedInboundId: 'msg_inbound_9',
			outcome: 'prefilled',
			readbackMatched: true,
		})
	})

	it('persists a receipt that carries no raw billing values', async () => {
		const { dataSource, receipts } = memoryDataSource({ purchases: PURCHASES })
		await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		const serialized = JSON.stringify(receipts)
		for (const value of BILLING_VALUES) {
			expect(serialized).not.toContain(value)
		}
	})

	it('returns not_found for an unknown charge and writes nothing', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
		})
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: 'mch_nope',
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		expect(result.state).toBe('not_found')
		expect(rows.size).toBe(0)
		expect(receipts).toHaveLength(0)
	})

	it('rejects when the named purchase does not match the charge purchase', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
		})
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: 'purchase_other',
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		expect(result.state).toBe('purchase_charge_mismatch')
		expect('invoicePath' in result).toBe(false)
		expect(rows.size).toBe(0)
		expect(receipts).toHaveLength(1)
		expect(receipts[0]?.outcome).toBe('purchase_charge_mismatch')
		expect(receipts[0]?.readbackMatched).toBeNull()
	})

	it('rejects an input hash that does not match the received settings, before any write', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
		})
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit({ inputHash: 'a'.repeat(64) }),
			},
			dataSource,
		)
		expect(result.state).toBe('input_hash_mismatch')
		expect('invoicePath' in result).toBe(false)
		expect(rows.size).toBe(0)
		expect(receipts).toHaveLength(1)
		expect(receipts[0]?.outcome).toBe('input_hash_mismatch')
	})

	it('issues no link when readback does not match, and the receipt records it', async () => {
		const { dataSource, receipts } = memoryDataSource({
			purchases: PURCHASES,
			corruptReadback: true,
		})
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		expect(result.state).toBe('readback_mismatch')
		expect('invoicePath' in result).toBe(false)
		expect(receipts).toHaveLength(1)
		expect(receipts[0]?.outcome).toBe('readback_mismatch')
		expect(receipts[0]?.readbackMatched).toBe(false)
	})

	it('rolls back the unverified write on readback mismatch and still records the receipt', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
			corruptReadback: true,
		})
		rows.set(settingsKey(PURCHASE_ID, CHARGE), existingOwnerRow())
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		expect(result.state).toBe('readback_mismatch')
		// The owner's verified row survives untouched; no support values leak in.
		expect(rows.get(settingsKey(PURCHASE_ID, CHARGE))).toEqual(
			existingOwnerRow(),
		)
		// The receipt lands outside the rolled-back write.
		expect(receipts).toHaveLength(1)
		expect(receipts[0]).toMatchObject({
			outcome: 'readback_mismatch',
			readbackMatched: false,
			runId: 'run_abc',
			operatorId: 'operator_jane',
		})
		expect(JSON.stringify(receipts)).not.toContain('Ada')
	})

	it('leaves no row at all when readback fails and nothing was saved before', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
			corruptReadback: true,
		})
		const result = await applySupportInvoicePrefill(
			{
				purchaseId: PURCHASE_ID,
				merchantChargeId: CHARGE,
				input: INPUT,
				audit: audit(),
			},
			dataSource,
		)
		expect(result.state).toBe('readback_mismatch')
		expect(rows.size).toBe(0)
		expect(receipts).toHaveLength(1)
	})
})

describe('computeSupportPrefillRequestKey', () => {
	const base = {
		purchaseId: PURCHASE_ID,
		merchantChargeId: CHARGE,
		audit: audit(),
	}

	it('is deterministic for the same signed request', () => {
		expect(computeSupportPrefillRequestKey(base)).toBe(
			computeSupportPrefillRequestKey({ ...base, audit: audit() }),
		)
		expect(computeSupportPrefillRequestKey(base)).toMatch(/^[0-9a-f]{64}$/)
	})

	it('binds purchase, charge, every audit field, and the input hash', () => {
		const original = computeSupportPrefillRequestKey(base)
		const variants = [
			{ ...base, purchaseId: 'purchase_2' },
			{ ...base, merchantChargeId: 'mch_456' },
			{ ...base, audit: audit({ runId: 'run_other' }) },
			{ ...base, audit: audit({ conversationId: 'cnv_front_2' }) },
			{ ...base, audit: audit({ operatorId: 'operator_bob' }) },
			{ ...base, audit: audit({ approvalReference: 'approval_778' }) },
			{ ...base, audit: audit({ expectedInboundId: 'msg_inbound_10' }) },
			{ ...base, audit: audit({ inputHash: 'b'.repeat(64) }) },
		]
		for (const variant of variants) {
			expect(computeSupportPrefillRequestKey(variant)).not.toBe(original)
		}
	})

	it('contains no billing values', () => {
		const key = computeSupportPrefillRequestKey(base)
		for (const value of BILLING_VALUES) expect(key).not.toContain(value)
	})
})

describe('isSupportPrefillRequestKeyCollision', () => {
	const dupMessage = `Duplicate entry 'abc' for key 'AI_SupportInvoicePrefillReceipt.${SUPPORT_PREFILL_REQUEST_KEY_INDEX}'`

	it('recognizes a mysql2 duplicate on the request-key index', () => {
		expect(
			isSupportPrefillRequestKeyCollision(
				Object.assign(new Error(dupMessage), {
					code: 'ER_DUP_ENTRY',
					errno: 1062,
					sqlMessage: dupMessage,
				}),
			),
		).toBe(true)
	})

	it('walks the cause chain', () => {
		const inner = Object.assign(new Error(dupMessage), { errno: 1062 })
		expect(
			isSupportPrefillRequestKeyCollision(
				new Error('query failed', { cause: inner }),
			),
		).toBe(true)
	})

	it('ignores duplicates on other keys and non-duplicate errors', () => {
		expect(
			isSupportPrefillRequestKeyCollision(
				Object.assign(
					new Error(
						"Duplicate entry 'sipr_x' for key 'AI_SupportInvoicePrefillReceipt.PRIMARY'",
					),
					{ code: 'ER_DUP_ENTRY', errno: 1062 },
				),
			),
		).toBe(false)
		expect(
			isSupportPrefillRequestKeyCollision(
				Object.assign(new Error(dupMessage), { code: 'ER_LOCK_DEADLOCK' }),
			),
		).toBe(false)
		expect(isSupportPrefillRequestKeyCollision(null)).toBe(false)
	})
})

describe('applySupportInvoicePrefill replay', () => {
	const request = () => ({
		purchaseId: PURCHASE_ID,
		merchantChargeId: CHARGE,
		input: INPUT,
		audit: audit(),
	})

	it('records the request key only on the prefilled receipt', async () => {
		const { dataSource, receipts } = memoryDataSource({ purchases: PURCHASES })
		await applySupportInvoicePrefill(request(), dataSource)
		expect(receipts[0]?.requestKey).toBe(
			computeSupportPrefillRequestKey(request()),
		)
	})

	it('refuses an exact replay without overwriting newer owner values, and adds no second success receipt', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
		})
		const first = await applySupportInvoicePrefill(request(), dataSource)
		expect(first.state).toBe('prefilled')
		if (first.state !== 'prefilled') return

		// The customer edits their invoice after the prefill landed.
		const ownerSave = await saveInvoiceSettingsForViewer(
			{
				merchantChargeId: CHARGE,
				viewerUserId: OWNER,
				input: { recipientName: 'Ada Byron', notes: 'newer' },
			},
			dataSource,
		)
		expect(ownerSave.state).toBe('saved')

		// The same signed request is delivered again inside the HMAC window.
		const replay = await applySupportInvoicePrefill(request(), dataSource)
		expect(replay.state).toBe('replayed')
		if (replay.state !== 'replayed') return
		expect('invoicePath' in replay).toBe(false)
		expect(replay.originalReceiptId).toBe(first.receipt.id)

		const row = rows.get(settingsKey(PURCHASE_ID, CHARGE))
		expect(row?.recipientName).toBe('Ada Byron')
		expect(row?.notes).toBe('newer')
		expect(row?.source).toBe('owner')

		expect(receipts.filter((r) => r.outcome === 'prefilled')).toHaveLength(1)
		expect(receipts.filter((r) => r.outcome === 'replayed')).toHaveLength(1)
		expect(replay.receipt.requestKey).toBeNull()
		expect(JSON.stringify(receipts)).not.toContain('Ada')
	})

	it('is refused at the commit boundary when the pre-check misses the prior success', async () => {
		const { dataSource, rows, receipts } = memoryDataSource({
			purchases: PURCHASES,
			hidePrefilledFromPrecheck: true,
		})
		const first = await applySupportInvoicePrefill(request(), dataSource)
		expect(first.state).toBe('prefilled')
		rows.set(settingsKey(PURCHASE_ID, CHARGE), existingOwnerRow())

		const replay = await applySupportInvoicePrefill(request(), dataSource)
		expect(replay.state).toBe('replayed')
		if (replay.state !== 'replayed') return
		// The pre-check cannot see the original here, so it is reported as unknown.
		expect(replay.originalReceiptId).toBeNull()
		expect(rows.get(settingsKey(PURCHASE_ID, CHARGE))).toEqual(
			existingOwnerRow(),
		)
		expect(receipts.filter((r) => r.outcome === 'prefilled')).toHaveLength(1)
	})

	it('is not a replay when the same run prefills a different conversation', async () => {
		const { dataSource, receipts } = memoryDataSource({ purchases: PURCHASES })
		expect(
			(await applySupportInvoicePrefill(request(), dataSource)).state,
		).toBe('prefilled')
		const second = await applySupportInvoicePrefill(
			{
				...request(),
				audit: audit({
					conversationId: 'cnv_front_2',
					expectedInboundId: 'msg_inbound_10',
				}),
			},
			dataSource,
		)
		expect(second.state).toBe('prefilled')
		expect(receipts.filter((r) => r.outcome === 'prefilled')).toHaveLength(2)
	})

	it('is not a replay when the same audit block carries different settings', async () => {
		const { dataSource, rows } = memoryDataSource({ purchases: PURCHASES })
		expect(
			(await applySupportInvoicePrefill(request(), dataSource)).state,
		).toBe('prefilled')
		const corrected = { ...INPUT, taxId: 'GB999999999' }
		const second = await applySupportInvoicePrefill(
			{
				...request(),
				input: corrected,
				audit: audit({ inputHash: computeInvoiceSettingsInputHash(corrected) }),
			},
			dataSource,
		)
		expect(second.state).toBe('prefilled')
		expect(rows.get(settingsKey(PURCHASE_ID, CHARGE))?.taxId).toBe(
			'GB999999999',
		)
	})

	it('allows an honest retry after a rolled-back readback mismatch', async () => {
		const options: StoreOptions = {
			purchases: PURCHASES,
			corruptReadback: true,
		}
		const { dataSource, receipts } = memoryDataSource(options)
		expect(
			(await applySupportInvoicePrefill(request(), dataSource)).state,
		).toBe('readback_mismatch')
		options.corruptReadback = false
		expect(
			(await applySupportInvoicePrefill(request(), dataSource)).state,
		).toBe('prefilled')
		expect(receipts.map((r) => r.outcome)).toEqual([
			'readback_mismatch',
			'prefilled',
		])
	})
})

describe('describeInvoiceSettingsForLog', () => {
	it('contains field names but no billing values', async () => {
		const { dataSource } = memoryDataSource({ purchases: PURCHASES })
		const result = await saveInvoiceSettingsForViewer(
			{ merchantChargeId: CHARGE, viewerUserId: OWNER, input: INPUT },
			dataSource,
		)
		expect(result.state).toBe('saved')
		if (result.state !== 'saved') return
		const summary = describeInvoiceSettingsForLog(result.settings)
		const serialized = JSON.stringify(summary)
		expect(summary.fieldsSet).toContain('taxId')
		expect(serialized).not.toContain('Ada')
		expect(serialized).not.toContain('GB123456789')
		expect(serialized).not.toContain('PO 4711')
		expect(serialized).not.toContain('Example Way')
	})
})
