import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	computeInvoiceSettingsInputHash,
	type InvoiceSettings,
	type InvoiceSettingsDataSource,
	type SupportPrefillReceipt,
} from '@/lib/invoice-settings'

const SECRET = 'test-support-secret'

vi.mock('@/env.mjs', () => ({
	env: {
		SUPPORT_WEBHOOK_SECRET: 'test-support-secret',
		NEXT_PUBLIC_URL: 'https://www.aihero.dev',
	},
}))

const logMock = vi.hoisted(() => ({
	entries: [] as { event: string; data: Record<string, unknown> }[],
}))

vi.mock('@/server/logger', () => ({
	log: {
		info: vi.fn(async (event: string, data: Record<string, unknown>) => {
			logMock.entries.push({ event, data })
		}),
		warn: vi.fn(async (event: string, data: Record<string, unknown>) => {
			logMock.entries.push({ event, data })
		}),
		error: vi.fn(async () => {}),
		debug: vi.fn(async () => {}),
	},
	createRequestContext: () => ({}),
	withLogContext: (_context: unknown, fn: () => unknown) => fn(),
	serializeError: (error: unknown) => ({ message: String(error) }),
}))

const store = vi.hoisted(() => ({
	rows: new Map<string, InvoiceSettings>(),
	receipts: [] as SupportPrefillReceipt[],
	purchases: new Map<
		string,
		{ id: string; userId: string | null; merchantChargeId: string | null }
	>(),
	corruptReadback: false,
}))

function settingsKey(purchaseId: string, merchantChargeId: string) {
	return `${purchaseId}::${merchantChargeId}`
}

vi.mock('@/lib/invoice-settings', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('@/lib/invoice-settings')>()
	const dataSource: InvoiceSettingsDataSource = {
		async loadPurchaseByMerchantChargeId(merchantChargeId) {
			return store.purchases.get(merchantChargeId) ?? null
		},
		async loadSettings(purchaseId, merchantChargeId) {
			const row = store.rows.get(settingsKey(purchaseId, merchantChargeId))
			if (!row) return null
			if (store.corruptReadback) {
				return { ...row, recipientName: 'someone else entirely' }
			}
			return row
		},
		async loadManagedTeamPurchases() {
			return []
		},
		async insertSupportReceipt(receipt) {
			store.receipts.push(receipt)
		},
		async commitVerifiedSettings(settings, successReceipt) {
			const key = settingsKey(settings.purchaseId, settings.merchantChargeId)
			const previous = store.rows.get(key)
			store.rows.set(key, settings)
			const readback = await this.loadSettings(
				settings.purchaseId,
				settings.merchantChargeId,
			)
			if (!readback || !original.settingsValuesMatch(settings, readback)) {
				if (previous) store.rows.set(key, previous)
				else store.rows.delete(key)
				return { verified: false, readback }
			}
			const receipt = successReceipt ? successReceipt(readback) : null
			if (receipt) store.receipts.push(receipt)
			return { verified: true, readback, receipt }
		},
	}
	return { ...original, drizzleInvoiceSettingsDataSource: dataSource }
})

import { POST } from '../route'

function signedRequest(
	body: unknown,
	{ sign = true, secret = SECRET }: { sign?: boolean; secret?: string } = {},
) {
	const bodyText = JSON.stringify(body)
	const headers = new Headers({ 'content-type': 'application/json' })
	if (sign) {
		const timestamp = Math.floor(Date.now() / 1000)
		const signature = createHmac('sha256', secret)
			.update(`${timestamp}.${bodyText}`)
			.digest('hex')
		headers.set('x-support-signature', `timestamp=${timestamp},v1=${signature}`)
	}
	return new NextRequest('http://localhost:3000/api/support/invoice-prefill', {
		method: 'POST',
		headers,
		body: bodyText,
	})
}

const SETTINGS = {
	recipientName: 'Ada Lovelace',
	companyName: 'Analytical Engines Ltd',
	address: '1 Example Way',
	taxId: 'GB123456789',
	notes: 'PO 4711',
}

const AUDIT = {
	runId: 'run_abc',
	conversationId: 'cnv_front_1',
	operatorId: 'operator_jane',
	approvalReference: 'approval_777',
	expectedInboundId: 'msg_inbound_9',
	inputHash: computeInvoiceSettingsInputHash(SETTINGS),
}

function requestBody(overrides: Record<string, unknown> = {}) {
	return {
		purchaseId: 'purchase_1',
		merchantChargeId: 'mch_123',
		settings: SETTINGS,
		audit: AUDIT,
		...overrides,
	}
}

describe('POST /api/support/invoice-prefill', () => {
	beforeEach(() => {
		store.rows.clear()
		store.receipts.length = 0
		store.purchases.clear()
		store.corruptReadback = false
		store.purchases.set('mch_123', {
			id: 'purchase_1',
			userId: 'user_1',
			merchantChargeId: 'mch_123',
		})
		logMock.entries.length = 0
	})

	it('rejects an unsigned request', async () => {
		const response = await POST(signedRequest(requestBody(), { sign: false }))
		expect(response.status).toBe(401)
		expect(store.rows.size).toBe(0)
	})

	it('rejects a request signed with the wrong secret', async () => {
		const response = await POST(
			signedRequest(requestBody(), { secret: 'wrong' }),
		)
		expect(response.status).toBe(401)
		expect(store.rows.size).toBe(0)
	})

	it('rejects a signature with a far-future timestamp', async () => {
		const bodyText = JSON.stringify(requestBody())
		const timestamp = Math.floor(Date.now() / 1000) + 600
		const signature = createHmac('sha256', SECRET)
			.update(`${timestamp}.${bodyText}`)
			.digest('hex')
		const request = new NextRequest(
			'http://localhost:3000/api/support/invoice-prefill',
			{
				method: 'POST',
				headers: new Headers({
					'content-type': 'application/json',
					'x-support-signature': `timestamp=${timestamp},v1=${signature}`,
				}),
				body: bodyText,
			},
		)
		const response = await POST(request)
		expect(response.status).toBe(401)
		expect(store.rows.size).toBe(0)
	})

	it('rejects a request missing the audit block', async () => {
		const { audit: _audit, ...withoutAudit } = requestBody()
		const response = await POST(signedRequest(withoutAudit))
		expect(response.status).toBe(400)
		expect(store.rows.size).toBe(0)
	})

	it('persists settings and returns the direct link after readback', async () => {
		const response = await POST(signedRequest(requestBody()))
		expect(response.status).toBe(200)
		const payload = await response.json()
		expect(payload.success).toBe(true)
		expect(payload.invoiceUrl).toBe('https://www.aihero.dev/invoices/mch_123')
		const row = store.rows.get(settingsKey('purchase_1', 'mch_123'))
		expect(row?.taxId).toBe('GB123456789')
		expect(row?.source).toBe('support')
		expect(row?.updatedByUserId).toBeNull()
		expect(row?.supportOperatorId).toBe('operator_jane')
		expect(store.receipts).toHaveLength(1)
		expect(store.receipts[0]?.outcome).toBe('prefilled')
		expect(payload.receiptId).toBe(store.receipts[0]?.id)
	})

	it('puts no billing values in the returned URL, logs, or receipts', async () => {
		const response = await POST(signedRequest(requestBody()))
		const payload = await response.json()
		const loggedText = JSON.stringify(logMock.entries)
		const receiptText = JSON.stringify(store.receipts)
		for (const value of Object.values(SETTINGS)) {
			expect(payload.invoiceUrl).not.toContain(value)
			expect(loggedText).not.toContain(value)
			expect(receiptText).not.toContain(value)
		}
	})

	it('returns 404 and no link for an unknown merchant charge', async () => {
		const response = await POST(
			signedRequest(requestBody({ merchantChargeId: 'mch_nope' })),
		)
		expect(response.status).toBe(404)
		const payload = await response.json()
		expect(payload.success).toBe(false)
		expect(payload.invoiceUrl).toBeUndefined()
	})

	it('returns 409 and no link when purchase and charge disagree', async () => {
		const response = await POST(
			signedRequest(requestBody({ purchaseId: 'purchase_other' })),
		)
		expect(response.status).toBe(409)
		const payload = await response.json()
		expect(payload.success).toBe(false)
		expect(payload.invoiceUrl).toBeUndefined()
		expect(store.rows.size).toBe(0)
		expect(store.receipts[0]?.outcome).toBe('purchase_charge_mismatch')
	})

	it('returns 422 and no link when the input hash does not match', async () => {
		const response = await POST(
			signedRequest(
				requestBody({ audit: { ...AUDIT, inputHash: 'a'.repeat(64) } }),
			),
		)
		expect(response.status).toBe(422)
		const payload = await response.json()
		expect(payload.success).toBe(false)
		expect(payload.invoiceUrl).toBeUndefined()
		expect(store.rows.size).toBe(0)
		expect(store.receipts[0]?.outcome).toBe('input_hash_mismatch')
	})

	it('returns a 5xx and no link when readback does not match', async () => {
		store.corruptReadback = true
		const response = await POST(signedRequest(requestBody()))
		expect(response.status).toBe(500)
		const payload = await response.json()
		expect(payload.success).toBe(false)
		expect(payload.invoiceUrl).toBeUndefined()
		expect(store.rows.size).toBe(0)
		expect(store.receipts).toHaveLength(1)
		expect(store.receipts[0]?.outcome).toBe('readback_mismatch')
		expect(store.receipts[0]?.readbackMatched).toBe(false)
	})

	it('rejects unexpected fields in settings', async () => {
		const response = await POST(
			signedRequest(
				requestBody({
					settings: { ...SETTINGS, creditCardNumber: '4242' },
				}),
			),
		)
		expect(response.status).toBe(400)
		expect(store.rows.size).toBe(0)
	})
})
