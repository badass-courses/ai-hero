import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }))
// A fail-closed DB boundary: the real authorization service runs below with
// in-memory repository methods, never a live connection.
vi.mock('@/db', () => ({
	db: new Proxy(
		{},
		{
			get() {
				throw new Error('Real DB forbidden')
			},
		},
	),
}))

import {
	drizzleInvoiceSettingsDataSource,
	type InvoiceSettings,
} from '@/lib/invoice-settings'
import { drizzleInvoiceLinkDataSource } from '@/lib/invoice-links'
import {
	saveInvoiceSettingsAction,
	copyInvoiceShareLinkAction,
	rotateInvoiceShareLinkAction,
} from './actions'

const CHARGE = 'mc_00000000-0000-4000-8000-000000000001'
const rows = new Map<string, InvoiceSettings>()
const original: InvoiceSettings = {
	purchaseId: 'purchase-synthetic',
	merchantChargeId: CHARGE,
	recipientName: 'Original Recipient',
	companyName: null,
	address: null,
	taxId: null,
	notes: 'Keep this',
	source: 'owner',
	updatedByUserId: 'payer',
	supportOperatorId: null,
}

beforeEach(() => {
	vi.restoreAllMocks()
	vi.resetAllMocks()
	vi.stubEnv(
		'INVOICE_LINK_SECRET',
		'synthetic-invoice-secret-with-at-least-32-bytes',
	)
	vi.spyOn(drizzleInvoiceLinkDataSource, 'loadVersion').mockResolvedValue(1)
	vi.spyOn(drizzleInvoiceLinkDataSource, 'rotateVersion').mockResolvedValue(2)
	rows.clear()
	rows.set(CHARGE, { ...original })
	mocks.auth.mockResolvedValue({ session: null })
	vi.spyOn(
		drizzleInvoiceSettingsDataSource,
		'loadPurchaseByMerchantChargeId',
	).mockResolvedValue({
		id: 'purchase-synthetic',
		userId: 'payer',
		billingUserId: 'payer',
		merchantChargeId: CHARGE,
	})
	vi.spyOn(
		drizzleInvoiceSettingsDataSource,
		'loadManagedTeamPurchases',
	).mockResolvedValue([])
	vi.spyOn(
		drizzleInvoiceSettingsDataSource,
		'commitVerifiedSettings',
	).mockImplementation(async (settings) => {
		rows.set(settings.merchantChargeId, settings)
		return { verified: true, readback: settings, receipt: null }
	})
})

describe('invoice share server actions', () => {
	it.each([null, 'other', 'unrelated-manager', 'learner'])(
		'refuses direct mint and rotate from %s',
		async (viewerUserId) => {
			mocks.auth.mockResolvedValue({
				session: viewerUserId ? { user: { id: viewerUserId } } : null,
			})
			vi.mocked(
				drizzleInvoiceSettingsDataSource.loadManagedTeamPurchases,
			).mockResolvedValue([{ id: 'other-purchase' }])
			expect((await copyInvoiceShareLinkAction(CHARGE)).state).toBe('denied')
			expect((await rotateInvoiceShareLinkAction(CHARGE)).state).toBe('denied')
			expect(drizzleInvoiceLinkDataSource.rotateVersion).not.toHaveBeenCalled()
			expect(
				drizzleInvoiceSettingsDataSource.commitVerifiedSettings,
			).not.toHaveBeenCalled()
			expect(rows.get(CHARGE)).toEqual(original)
			expect(mocks.revalidate).not.toHaveBeenCalled()
		},
	)
	it.each(['payer', 'manager'])(
		'permits direct share calls from %s without changing invoice details',
		async (viewerUserId) => {
			mocks.auth.mockResolvedValue({ session: { user: { id: viewerUserId } } })
			if (viewerUserId === 'manager')
				vi.mocked(
					drizzleInvoiceSettingsDataSource.loadManagedTeamPurchases,
				).mockResolvedValue([{ id: 'purchase-synthetic' }])
			expect((await copyInvoiceShareLinkAction(CHARGE)).state).toBe('minted')
			expect((await rotateInvoiceShareLinkAction(CHARGE)).state).toBe('minted')
			expect(drizzleInvoiceLinkDataSource.rotateVersion).toHaveBeenCalledWith(
				'purchase-synthetic',
				CHARGE,
			)
			expect(
				drizzleInvoiceSettingsDataSource.commitVerifiedSettings,
			).not.toHaveBeenCalled()
			expect(rows.get(CHARGE)).toEqual(original)
			expect(mocks.revalidate).toHaveBeenCalledOnce()
		},
	)
	it('fails closed before rotation when the secret is missing', async () => {
		vi.stubEnv('INVOICE_LINK_SECRET', '')
		mocks.auth.mockResolvedValue({ session: { user: { id: 'payer' } } })
		expect((await copyInvoiceShareLinkAction(CHARGE)).state).toBe('unavailable')
		expect((await rotateInvoiceShareLinkAction(CHARGE)).state).toBe(
			'unavailable',
		)
		expect(drizzleInvoiceLinkDataSource.rotateVersion).not.toHaveBeenCalled()
	})
})

describe('invoice save server action authorization', () => {
	it.each([null, 'other', 'unrelated-manager'])(
		'refuses a direct action call from %s without writing',
		async (viewerUserId) => {
			mocks.auth.mockResolvedValue({
				session: viewerUserId ? { user: { id: viewerUserId } } : null,
			})
			vi.mocked(
				drizzleInvoiceSettingsDataSource.loadManagedTeamPurchases,
			).mockResolvedValue([{ id: 'another-purchase' }])
			const result = await saveInvoiceSettingsAction(CHARGE, {
				recipientName: 'Unauthorized Change',
			})
			expect(result.state).toBe('denied')
			expect(rows.get(CHARGE)).toEqual(original)
			expect(
				drizzleInvoiceSettingsDataSource.commitVerifiedSettings,
			).not.toHaveBeenCalled()
			expect(mocks.revalidate).not.toHaveBeenCalled()
		},
	)

	it('does not let the transferred learner edit the payer invoice', async () => {
		mocks.auth.mockResolvedValue({ session: { user: { id: 'learner' } } })
		vi.mocked(
			drizzleInvoiceSettingsDataSource.loadPurchaseByMerchantChargeId,
		).mockResolvedValue({
			id: 'purchase-synthetic',
			userId: 'learner',
			billingUserId: 'payer',
			merchantChargeId: CHARGE,
		})
		expect(
			(
				await saveInvoiceSettingsAction(CHARGE, {
					recipientName: 'Learner Change',
				})
			).state,
		).toBe('denied')
		expect(rows.get(CHARGE)).toEqual(original)
		expect(
			drizzleInvoiceSettingsDataSource.commitVerifiedSettings,
		).not.toHaveBeenCalled()
		expect(mocks.revalidate).not.toHaveBeenCalled()
	})

	it.each(['payer', 'manager'])(
		'allows %s to save through the real authorization service',
		async (viewerUserId) => {
			mocks.auth.mockResolvedValue({ session: { user: { id: viewerUserId } } })
			if (viewerUserId === 'manager') {
				vi.mocked(
					drizzleInvoiceSettingsDataSource.loadManagedTeamPurchases,
				).mockResolvedValue([{ id: 'purchase-synthetic' }])
			}
			const result = await saveInvoiceSettingsAction(CHARGE, {
				recipientName: 'Approved Recipient',
			})
			expect(result.state).toBe('saved')
			expect(rows.get(CHARGE)?.recipientName).toBe('Approved Recipient')
			expect(rows.get(CHARGE)?.updatedByUserId).toBe(viewerUserId)
			expect(
				drizzleInvoiceSettingsDataSource.commitVerifiedSettings,
			).toHaveBeenCalledOnce()
			expect(mocks.revalidate).toHaveBeenCalledWith(`/invoices/${CHARGE}`)
		},
	)
})
