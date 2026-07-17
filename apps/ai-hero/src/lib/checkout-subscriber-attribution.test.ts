import { describe, expect, it } from 'vitest'
import {
	addKitSubscriberToCheckoutAttribution,
	normalizeCheckoutKitSubscriberId,
} from './checkout-subscriber-attribution'

describe('checkout Kit subscriber attribution', () => {
	it('normalizes raw and JSON-encoded subscriber cookies', () => {
		expect(normalizeCheckoutKitSubscriberId(' 123456 ')).toBe('123456')
		expect(normalizeCheckoutKitSubscriberId('"123456"')).toBe('123456')
	})

	it('creates an attribution snapshot for a Kit-only email visit', () => {
		const result = addKitSubscriberToCheckoutAttribution({
			checkoutAttribution: {},
			rawSubscriberId: '123456',
			now: () => new Date('2026-07-17T12:00:00.000Z'),
		})

		expect(JSON.parse(result.attributionSnapshot!)).toEqual({
			schemaVersion: 1,
			capturedAt: '2026-07-17T12:00:00.000Z',
			kitSubscriberId: '123456',
		})
	})

	it('preserves checkout click evidence while adding the Kit identity', () => {
		const result = addKitSubscriberToCheckoutAttribution({
			checkoutAttribution: {
				attributionSnapshot: JSON.stringify({
					schemaVersion: 1,
					capturedAt: '2026-07-01T12:00:00.000Z',
					clickIds: { gclid: 'real-click' },
					utm: { source: 'google', medium: 'cpc' },
				}),
			},
			rawSubscriberId: '123456',
		})

		expect(result.attributionSnapshot!.length).toBeLessThanOrEqual(500)
		expect(JSON.parse(result.attributionSnapshot!)).toMatchObject({
			kitSubscriberId: '123456',
			clickIds: { gclid: 'real-click' },
		})
	})
})
