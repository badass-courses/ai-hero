import { describe, expect, it } from 'vitest'

import {
	isArchiveDerivedEntitlement,
	summarizeArchiveEntitlements,
} from './archive-entitlements'

describe('archive entitlements helpers', () => {
	it('detects archive-derived entitlements using archive metadata', () => {
		const entitlement = {
			entitlementType: 'cohort_content_access',
			sourceId: 'purchase-1',
			metadata: {
				archiveProductId: 'product-1',
				archivePurchaseId: 'purchase-1',
				archiveCohortId: 'cohort-1',
			},
		}

		expect(
			isArchiveDerivedEntitlement(entitlement as any, {
				purchaseId: 'purchase-1',
				productId: 'product-1',
			}),
		).toBe(true)
	})

	it('does not treat ordinary cohort access as archive-derived', () => {
		const entitlement = {
			entitlementType: 'cohort_content_access',
			sourceId: 'purchase-1',
			metadata: {
				contentIds: ['lesson-1'],
			},
		}

		expect(
			isArchiveDerivedEntitlement(entitlement as any, {
				purchaseId: 'purchase-1',
				productId: 'product-1',
			}),
		).toBe(false)
	})

	it('summarizes archive entitlements into support-friendly modules', () => {
		const entitlements = [
			{
				id: 'ent-1',
				expiresAt: new Date('2026-03-01T00:00:00.000Z'),
				metadata: {
					archiveCohortId: 'cohort-1',
					archiveCohortTitle: 'AI Hero Cohort 1',
				},
			},
			{
				id: 'ent-2',
				expiresAt: new Date('2026-03-01T00:00:00.000Z'),
				metadata: {
					archiveCohortId: 'cohort-2',
					archiveCohortTitle: 'AI Hero Cohort 2',
				},
			},
		]

		const result = summarizeArchiveEntitlements(entitlements as any)

		expect(result).toEqual({
			modules: [
				{
					id: 'cohort-1',
					title: 'AI Hero Cohort 1',
					accessible: true,
				},
				{
					id: 'cohort-2',
					title: 'AI Hero Cohort 2',
					accessible: true,
				},
			],
			expiresAt: '2026-03-01T00:00:00.000Z',
		})
	})
})
