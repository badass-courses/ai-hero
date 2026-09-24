import { expect, test, type Page } from '@playwright/test'

import {
	couponCode,
	fixtureProduct as product,
	merchantCouponId,
	siteCouponId,
} from './fixture-data'

// Every response in this file comes from the in-memory fixture below: no
// database, no coupon row, no session and no Stripe object. It proves the
// browser half of a coupon link (query → actor → price → checkout form); the
// server's coupon authority is proven post-deploy by the synthetic principal.
type Fixture = {
	priceStatus?: number
	priceRequests: Array<string | null>
	checkouts: URL[]
	foreignRequests: string[]
}

// Match on this origin only: a `**/api/...` glob would also answer a request
// that escaped to another host and hide the cross-origin bug.
const local = (pathname: string) => (url: URL) =>
	url.hostname === 'localhost' && url.pathname === pathname

async function mountFixture(
	page: Page,
	options: { priceStatus?: number } = {},
) {
	const fixture: Fixture = {
		priceStatus: options.priceStatus,
		priceRequests: [],
		checkouts: [],
		foreignRequests: [],
	}
	// Nothing leaves the fixture origin; a cross-origin price call is a failure.
	await page.route(
		(url) => url.hostname !== 'localhost',
		async (route) => {
			fixture.foreignRequests.push(route.request().url())
			await route.abort()
		},
	)
	await page.route(
		local('/api/trpc/pricing.propsForCommerce'),
		async (route) => {
			const url = new URL(route.request().url())
			const input = JSON.parse(url.searchParams.get('input') ?? '{}').json ?? {}
			const data =
				input.coupon === siteCouponId
					? { products: [product], couponIdFromCoupon: siteCouponId }
					: input.code === couponCode
						? {
								products: [product],
								couponFromCode: {
									id: siteCouponId,
									isValid: true,
									isRedeemable: false,
								},
								// As the server does: a valid code resolves to its coupon id.
								couponIdFromCoupon: siteCouponId,
							}
						: { products: [product] }
			await route.fulfill({ json: { result: { data: { json: data } } } })
		},
	)
	await page.route(
		local('/api/coursebuilder/prices-formatted'),
		async (route) => {
			const body = route.request().postDataJSON() as { couponId?: string }
			fixture.priceRequests.push(body.couponId ?? null)
			if (fixture.priceStatus) {
				await route.fulfill({
					status: fixture.priceStatus,
					body: 'unavailable',
				})
				return
			}
			const discounted = body.couponId === siteCouponId
			await route.fulfill({
				json: {
					id: product.id,
					quantity: 1,
					unitPrice: 299,
					fullPrice: 299,
					calculatedPrice: discounted ? 199 : 299,
					availableCoupons: [],
					usedCouponId: discounted ? siteCouponId : null,
					appliedMerchantCoupon: discounted
						? { id: merchantCouponId, type: 'special' }
						: null,
				},
			})
		},
	)
	await page.route(
		local('/api/coursebuilder/checkout/stripe'),
		async (route) => {
			// Stop at the checkout request: assert what would go to Stripe, create nothing.
			fixture.checkouts.push(new URL(route.request().url()))
			await route.fulfill({
				contentType: 'text/html',
				body: 'checkout intercepted',
			})
		},
	)
	return fixture
}

const buyButtons = (page: Page) =>
	page.getByRole('button', { name: /^(Buy Now|Price unavailable)/ })

for (const query of [`coupon=${siteCouponId}`, `code=${couponCode}`]) {
	test(`?${query} prices every CTA at $199 and checks out with the coupon`, async ({
		page,
	}) => {
		const fixture = await mountFixture(page)
		await page.goto(`/?${query}`)

		const sidebar = page.getByTestId('sidebar-cta')
		const inline = page.getByTestId('inline-cta')
		await expect(
			sidebar.getByRole('button', { name: /Buy Now\s*\$199/ }),
		).toBeEnabled()
		await expect(
			inline.getByRole('button', { name: /Buy Now\s*\$199/ }),
		).toBeEnabled()
		await expect(buyButtons(page)).toHaveCount(2)
		for (const label of await buyButtons(page).allInnerTexts()) {
			expect(label).toContain('$199')
			expect(label).not.toContain('$0')
		}
		expect(fixture.priceRequests).toContain(siteCouponId)

		await inline.getByRole('button', { name: /Buy Now\s*\$199/ }).click()
		await expect(page.getByText('checkout intercepted')).toBeVisible()
		const [checkout] = fixture.checkouts
		expect(checkout?.pathname).toBe('/api/coursebuilder/checkout/stripe')
		expect(checkout?.searchParams.get('productId')).toBe(product.id)
		expect(checkout?.searchParams.get('couponId')).toBe(merchantCouponId)
		expect(checkout?.searchParams.get('usedCouponId')).toBe(siteCouponId)
		expect(fixture.foreignRequests).toEqual([])
	})
}

test('without a coupon every CTA shows the full $299 price', async ({
	page,
}) => {
	const fixture = await mountFixture(page)
	await page.goto('/')

	await expect(
		page
			.getByTestId('sidebar-cta')
			.getByRole('button', { name: /Buy Now\s*\$299/ }),
	).toBeEnabled()
	await expect(
		page
			.getByTestId('inline-cta')
			.getByRole('button', { name: /Buy Now\s*\$299/ }),
	).toBeEnabled()
	expect(fixture.priceRequests.every((couponId) => couponId === null)).toBe(
		true,
	)
	expect(fixture.foreignRequests).toEqual([])
})

test('a failed price request shows Price unavailable, never $0 or a live checkout', async ({
	page,
}) => {
	const fixture = await mountFixture(page, { priceStatus: 503 })
	await page.goto(`/?coupon=${siteCouponId}`)

	await expect(page.getByRole('alert').first()).toContainText(
		'Price unavailable',
	)
	await expect(buyButtons(page)).toHaveCount(2)
	for (const button of await buyButtons(page).all()) {
		await expect(button).toBeDisabled()
		await expect(button).not.toContainText('$')
	}
	expect(fixture.priceRequests.length).toBeGreaterThan(0)
	expect(fixture.checkouts).toEqual([])
})
