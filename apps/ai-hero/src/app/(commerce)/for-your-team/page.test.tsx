import * as React from 'react'
import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sale = vi.hoisted(() => ({ active: false }))
vi.mock('@/components/c5-sale-switch', () => ({
	C5SaleSwitch: ({
		children,
		fallback,
	}: {
		children: React.ReactNode
		fallback: React.ReactNode
	}) => (sale.active ? children : fallback),
}))
beforeEach(() => {
	sale.active = false
})

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/landing/company-logo-grid', () => ({
	CompanyLogoGrid: () => null,
}))
vi.mock('@/components/landing/hero-shader', () => ({ HeroShader: () => null }))
vi.mock('@/components/pricing/pricing-inline', () => ({
	PricingInline: () => null,
}))
vi.mock('@/components/team-inquiry/team-inquiry-form', () => ({
	TeamInquiryForm: () => <div data-quote-form="" />,
}))
vi.mock('@/components/team-invoice/team-invoice-form', () => ({
	TeamInvoiceForm: ({ productId }: { productId: string }) => (
		<div data-invoice-product={productId} />
	),
}))
vi.mock('@/lib/cohorts-query', () => ({ getCachedCohort: async () => null }))
vi.mock('@/lib/workshops-query', () => ({
	getCachedMinimalWorkshop: async () => null,
}))
vi.mock('@/env.mjs', () => ({ env: { NEXT_PUBLIC_URL: 'http://localhost' } }))
vi.mock(
	'../../(content)/workshops/_components/workshop-public-pricing-server',
	() => ({ PublicWorkshopPricing: () => null }),
)

import TeamPage from './page'

const render = async () => renderToStaticMarkup(await TeamPage())

describe('team hub C5 card', () => {
	it('puts the live cohort team destination ahead of the catalog during enrollment', async () => {
		sale.active = true
		const html = await render()
		expect(html).toContain(
			'href="/cohorts/software-factories-for-real-engineers-xdy1m/for-teams"',
		)
		expect(html).toContain('Join with your team')
	})
	it('shows the approved ladder and its validity, without replacing the older offers', async () => {
		const html = await render()
		expect(html).toContain('AI Coding Crash Course')
		expect(html).toContain('AI Coding for Real Engineers')
		expect(html).toContain('Software Factories for Real Engineers')
		expect(html).toContain('November 2, 2026')
		for (const text of [
			'1 to 4',
			'30%',
			'$906.50',
			'5 to 9',
			'35%',
			'$841.75',
			'10 to 29',
			'40%',
			'$777.00',
			'30+',
			'45%',
			'$712.25',
		]) {
			expect(html).toContain(text)
		}
		expect(html).not.toContain('—')
	})

	it('connects C5 seats, the existing invoice form, email, quote form and manual team credit', async () => {
		const html = await render()
		expect(html).toContain('productId=product-s00zs')
		expect(html).toContain('href="#c5-team-invoice"')
		expect(html).toContain('data-invoice-product="product-s00zs"')
		expect(html).toContain('href="mailto:team@aihero.dev"')
		expect(html).toContain('href="#contact"')
		expect(html).toContain('data-quote-form=""')
		expect(html).toContain('Already bought Crash Course team seats')
		expect(html).toContain('That credit is handled manually.')
	})

	it('redirects the short team address to the existing hub', async () => {
		const config = await readFile(
			new URL('../../../../next.config.mjs', import.meta.url),
			'utf8',
		)
		expect(config).toMatch(
			/source: '\/for-teams',\s+destination: '\/for-your-team',\s+permanent: true/,
		)
	})
})
