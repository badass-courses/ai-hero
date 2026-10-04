import { beforeEach, describe, expect, it } from 'vitest'
import {
	mintInvoiceLinkForViewer,
	rotateInvoiceLinkForViewer,
	mintSupportInvoiceLink,
	type InvoiceLinkDataSource,
} from './invoice-links'
import { verifyInvoiceLinkToken } from './invoice-link-token'

const charge = 'mc_synthetic_a'
const config = { secret: 'synthetic-invoice-secret-with-at-least-32-bytes' }
let version: number
let rotations: number
const dataSource: InvoiceLinkDataSource = {
	async loadPurchaseByMerchantChargeId(id) {
		return id === charge
			? {
					id: 'purchase-a',
					merchantChargeId: charge,
					userId: 'learner',
					billingUserId: 'payer',
				}
			: null
	},
	async loadManagedTeamPurchases(user) {
		return user === 'manager'
			? [{ id: 'purchase-a' }]
			: user === 'unrelated-manager'
				? [{ id: 'purchase-b' }]
				: []
	},
	async loadVersion() {
		return version
	},
	async rotateVersion() {
		rotations++
		return ++version
	},
}
beforeEach(() => {
	version = 1
	rotations = 0
})

describe('invoice link authorization and revocation', () => {
	it.each([undefined, 'other', 'unrelated-manager', 'learner'])(
		'refuses mint and rotate from %s',
		async (viewerUserId) => {
			const input = { merchantChargeId: charge, viewerUserId }
			expect(
				(await mintInvoiceLinkForViewer(input, dataSource, config)).state,
			).toBe('denied')
			expect(
				(await rotateInvoiceLinkForViewer(input, dataSource, config)).state,
			).toBe('denied')
			expect(rotations).toBe(0)
		},
	)
	it.each(['payer', 'manager'])(
		'lets %s mint and rotate, revoking all older links',
		async (viewerUserId) => {
			const input = { merchantChargeId: charge, viewerUserId }
			const old = await mintInvoiceLinkForViewer(input, dataSource, config)
			expect(old.state).toBe('minted')
			if (old.state !== 'minted') throw new Error('Mint failed')
			const token = new URL(
				old.invoicePath,
				'https://example.invalid',
			).searchParams.get('t')
			expect(
				verifyInvoiceLinkToken({
					token,
					chargeId: charge,
					linkVersion: version,
					secret: config.secret,
				}),
			).toBe(true)
			const rotated = await rotateInvoiceLinkForViewer(
				input,
				dataSource,
				config,
			)
			expect(rotated.state).toBe('minted')
			expect(version).toBe(2)
			expect(rotations).toBe(1)
			expect(
				verifyInvoiceLinkToken({
					token,
					chargeId: charge,
					linkVersion: version,
					secret: config.secret,
				}),
			).toBe(false)
		},
	)
	it('support mints without changing invoice details or link version', async () => {
		expect(
			(
				await mintSupportInvoiceLink(
					{ merchantChargeId: charge },
					dataSource,
					config,
				)
			).state,
		).toBe('minted')
		expect(rotations).toBe(0)
	})
	it('refuses nonexistent invoices', async () => {
		expect(
			(
				await mintSupportInvoiceLink(
					{ merchantChargeId: 'mc_unknown' },
					dataSource,
					config,
				)
			).state,
		).toBe('not_found')
	})
	it('does not rotate or mint when the secret is missing', async () => {
		const input = { merchantChargeId: charge, viewerUserId: 'payer' }
		expect((await mintInvoiceLinkForViewer(input, dataSource, {})).state).toBe(
			'unavailable',
		)
		expect(
			(await rotateInvoiceLinkForViewer(input, dataSource, {})).state,
		).toBe('unavailable')
		expect((await mintSupportInvoiceLink(input, dataSource, {})).state).toBe(
			'unavailable',
		)
		expect(rotations).toBe(0)
	})
	it('refuses mint and rotation with a 31-byte secret before any write', async () => {
		const input = { merchantChargeId: charge, viewerUserId: 'payer' }
		const short = { secret: 's'.repeat(31) }
		expect(
			(await mintInvoiceLinkForViewer(input, dataSource, short)).state,
		).toBe('unavailable')
		expect(
			(await rotateInvoiceLinkForViewer(input, dataSource, short)).state,
		).toBe('unavailable')
		expect((await mintSupportInvoiceLink(input, dataSource, short)).state).toBe(
			'unavailable',
		)
		expect(rotations).toBe(0)
	})
	it('refuses invalid TTL before changing the version', async () => {
		const input = { merchantChargeId: charge, viewerUserId: 'payer' }
		expect(
			(
				await rotateInvoiceLinkForViewer(input, dataSource, {
					...config,
					ttlDays: '0',
				})
			).state,
		).toBe('unavailable')
		expect(rotations).toBe(0)
	})
})
