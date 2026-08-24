import { describe, expect, it } from 'vitest'

import {
	applySupportInvoicePrefill,
	computeInvoiceSettingsInputHash,
	describeInvoiceSettingsForLog,
	saveInvoiceSettingsForViewer,
	settingsValuesMatch,
	type InvoiceSettings,
	type InvoiceSettingsDataSource,
	type SupportPrefillAudit,
	type SupportPrefillReceipt,
} from './invoice-settings'

type StoreOptions = {
	purchases?: { merchantChargeId: string; id: string; userId: string | null }[]
	managedPurchaseIds?: Record<string, string[]>
	corruptReadback?: boolean
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
		// Mirrors the drizzle transaction: the write only survives when the
		// readback matches; otherwise the prior row (or absence) is restored
		// and nothing else from this call is persisted.
		async commitVerifiedSettings(settings, successReceipt) {
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
				return { verified: false, readback }
			}
			const receipt = successReceipt ? successReceipt(readback) : null
			if (receipt) receipts.push(receipt)
			return { verified: true, readback, receipt }
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
