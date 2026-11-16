import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: 'unauthenticated' }),
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://example.test' },
}))
vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))
vi.mock('@/app/(content)/workshops/_components/pricing-widget', () => ({
	PricingWidget: () => <button>Individual checkout</button>,
}))
vi.mock('@/components/cta/conversion-intent-form', () => ({
	ConversionIntentForm: () => <form>Join Waitlist</form>,
}))
vi.mock('@/components/cta/conversion-intent-button', () => ({
	ConversionIntentButton: () => null,
}))
vi.mock('@/components/cld-image', () => ({ CldImage: () => null }))
vi.mock('@/components/commerce/checkout-survey-buy-button', () => ({
	CheckoutSurveyBuyButton: () => null,
}))
vi.mock('@/app/(content)/workshops/_components/regional-pricing-note', () => ({
	RegionalPricingNote: () => null,
}))
vi.mock('./cohort-includes', () => ({
	CohortIncludes: () => null,
	cohortLessonFeatures: () => [],
}))
vi.mock('./cohort-team-link', () => ({
	CohortTeamLink: ({ href }: { href: string }) => (
		<a href={href}>Team seats and invoices</a>
	),
}))

import { CohortPricingWidgetContainer } from './cohort-pricing-widget-container'

const render = (closeEnrollment: string, allowPurchase?: string) =>
	renderToStaticMarkup(
		<CohortPricingWidgetContainer
			{...({
				cohort: { fields: { title: 'Test Cohort', slug: 'test-cohort' } },
				products: [
					{
						id: 'product-test',
						name: 'Test Cohort',
						status: 1,
						fields: {
							state: 'published',
							openEnrollment: '2026-11-01T00:00:00Z',
							closeEnrollment,
						},
					},
				],
				isOnWaitlist: false,
				knownIdentity: false,
				workshops: [],
				lessonCount: 0,
				teamOptionsHref: '/cohorts/test-cohort/for-teams',
				searchParams: { allowPurchase },
			} as any)}
		/>,
	)

describe('cohort rail purchase controls', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it.each([undefined, 'false'])(
		'hides individual checkout after close (override %s), keeping the org path',
		(override) => {
			const html = render('2026-11-10T00:00:00Z', override)
			expect(html).not.toContain('Individual checkout')
			expect(html).toContain('Join Waitlist')
			expect(html).toContain('/cohorts/test-cohort/for-teams')
			expect(html).toContain('Team seats and invoices')
		},
	)

	it('keeps individual checkout during open enrollment', () => {
		expect(render('2026-11-20T00:00:00Z')).toContain('Individual checkout')
	})
})
