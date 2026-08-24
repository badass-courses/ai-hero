import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: null }))

import type { PurchaseTickerHit } from './admin-sales-globe-contract'
import {
	applyStripeBillingToHit,
	enrichGlobeHitsFromStripe,
	persistPurchaseGeoFromStripe,
	stripeAddressFromFields,
} from './admin-sales-globe-stripe-geo'

const usHit: PurchaseTickerHit = {
	id: 'purchase_us',
	createdAt: new Date('2026-08-21T17:00:00.000Z'),
	amount: 199,
	productName: 'Crash Course',
	productId: 'product_1',
	country: 'US',
	userName: 'Ada',
	userEmail: 'ada@example.com',
	userImage: null,
	city: null,
	region: null,
	lat: 38,
	lng: -97,
	isTeam: false,
	seats: null,
}

describe('stripe billing onto globe hits', () => {
	it('reads Stripe address fields and ignores an empty address', () => {
		expect(
			stripeAddressFromFields({
				city: 'Austin',
				state: 'TX',
				postal_code: '78701',
				country: 'US',
			})
		).toEqual({
			city: 'Austin',
			region: 'TX',
			postal: '78701',
			country: 'US',
		})
		expect(stripeAddressFromFields({})).toBeNull()
	})

	it('upgrades a US country ping to the billing ZIP', () => {
		const upgraded = applyStripeBillingToHit(usHit, {
			city: 'San Francisco',
			region: 'CA',
			postal: '94107',
			country: 'US',
		})
		expect(upgraded).toMatchObject({
			city: 'San Francisco',
			region: 'CA',
			lat: 37.7621,
			lng: -122.3971,
		})
	})

	it('does not move a TH ping to a US billing ZIP', () => {
		expect(
			applyStripeBillingToHit(
				{ ...usHit, country: 'TH', lat: 15, lng: 100 },
				{
					city: 'Austin',
					region: 'TX',
					postal: '78701',
					country: 'US',
				}
			)
		).toBeNull()
	})

	it('enriches country-only hits and skips hits that already have a city', async () => {
		const persist = vi.fn().mockResolvedValue(undefined)
		const readBilling = vi.fn(async (row: { id: string }) =>
			row.id === 'purchase_us'
				? {
						city: 'San Francisco',
						region: 'CA',
						postal: '94107',
						country: 'US',
					}
				: {
						city: 'Austin',
						region: 'TX',
						postal: '78701',
						country: 'US',
					}
		)

		const [us, austin] = await enrichGlobeHitsFromStripe({
			hits: [
				usHit,
				{
					...usHit,
					id: 'purchase_austin',
					city: 'Austin',
					region: 'TX',
					lat: 30.2672,
					lng: -97.7431,
				},
			],
			rows: [
				{
					id: 'purchase_us',
					country: 'US',
					fields: {},
					sessionIdentifier: 'cs_test',
					chargeIdentifier: 'ch_test',
				},
				{
					id: 'purchase_austin',
					country: 'US',
					fields: {},
					sessionIdentifier: 'cs_test_2',
					chargeIdentifier: 'ch_test_2',
				},
			],
			readBilling,
			persist,
		})

		expect(us).toMatchObject({ city: 'San Francisco', lat: 37.7621 })
		expect(austin).toMatchObject({ city: 'Austin', lat: 30.2672 })
		expect(readBilling).toHaveBeenCalledOnce()
		expect(persist).toHaveBeenCalledOnce()
	})

	it('persists matching Stripe billing through the purchase geo writer', async () => {
		const persist = vi.fn().mockResolvedValue(undefined)
		const plan = await persistPurchaseGeoFromStripe({
			row: {
				id: 'purchase_us',
				country: 'US',
				city: null,
				state: null,
				ipAddress: null,
				fields: {},
				sessionIdentifier: 'cs_test',
				chargeIdentifier: 'ch_test',
			},
			readGeo: async () => ({
				address: {
					city: 'San Francisco',
					region: 'CA',
					postal: '94107',
					country: 'US',
				},
				metadata: { ip_address: '203.0.113.9' },
			}),
			persist,
		})

		expect(plan).toMatchObject({
			skip: false,
			city: 'San Francisco',
			state: 'CA',
			ipAddress: '203.0.113.9',
			source: 'stripe-billing',
		})
		expect(persist).toHaveBeenCalledOnce()
	})
})
