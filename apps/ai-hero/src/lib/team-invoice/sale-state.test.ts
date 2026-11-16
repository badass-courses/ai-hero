import { describe, expect, it } from 'vitest'

import {
	cohortCallsToAction,
	cohortEnrollmentPhase,
} from '@/app/(content)/cohorts/[slug]/_components/cohort-coming-soon'

import { teamSaleState, type TeamSaleProduct } from './sale-state'

const now = new Date('2026-11-16T12:00:00Z')
const product: TeamSaleProduct = {
	id: 'product-team',
	type: 'cohort',
	status: 1,
	quantityAvailable: 10,
	fields: {
		state: 'published',
		openEnrollment: '2026-11-01T00:00:00Z',
		closeEnrollment: '2026-11-10T00:00:00Z',
	},
}
const options = { now, purchaseCount: 5, seats: 5 }

describe('org team sales after individual enrollment closes', () => {
	it.each(['cohort', 'live'])('sells team seats for a closed %s', (type) => {
		expect(teamSaleState({ ...product, type }, options)).toEqual({
			onSale: true,
		})
	})

	it.each([product.fields?.openEnrollment, undefined])(
		'keeps individual enrollment closed (open date %s)',
		(openEnrollment) => {
			const phase = cohortEnrollmentPhase({
				now,
				openEnrollment: openEnrollment as string | undefined,
				closeEnrollment: product.fields?.closeEnrollment as string,
			})
			expect(phase).toBe('closed')
			expect(
				cohortCallsToAction({
					phase,
					productState: 'published',
					allowPurchase: undefined,
					hasCohortAccess: false,
					isOnWaitlist: false,
					hasActiveProduct: true,
					bypassSoldOut: false,
				}),
			).toMatchObject({
				canEnroll: false,
				mobileCta: 'waitlist',
				offerInJsonLd: false,
			})
		},
	)

	it.each([
		[{ status: 0 }, 'archived'],
		[{ fields: { ...product.fields, state: 'draft' } }, 'unpublished'],
		[
			{ fields: { ...product.fields, openEnrollment: '2026-12-01T00:00:00Z' } },
			'upcoming',
		],
		[{ quantityAvailable: 9 }, 'sold-out'],
		[{ type: 'other' }, 'not-team-product'],
	] as const)('preserves the %s guard', (override, reason) => {
		expect(teamSaleState({ ...product, ...override }, options)).toEqual({
			onSale: false,
			reason,
		})
	})
})
