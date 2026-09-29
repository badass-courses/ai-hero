import { expect, test, type Page } from '@playwright/test'

import {
	EVERGREEN_OFFER_FIELD_KEYS,
	offerFieldsFor,
	type CouponIssuePayload,
} from '../src/lib/subscriber-marketing/drovr-evergreen-coupon'
import {
	issuedRow,
	offerPayload,
} from '../src/lib/subscriber-marketing/evergreen-offer-status.fixtures'
import { createEvergreenOfferStatusHandler } from '../src/server/evergreen-offer-status'

// The recipient's view of an evergreen offer link: no cookie, no session. The
// status route is the production handler over a coupon row the real authority
// wrote (no database); the notice is the production component. Only the clock
// is ours: the handler reads it, so "before" and "after" are one coupon.
async function openOfferLink(page: Page, issue: CouponIssuePayload, now: string) {
	const { row, couponId } = await issuedRow(issue)
	const handler = createEvergreenOfferStatusHandler({
		loadCoupon: async (id) => (id === couponId ? row : null),
		now: () => now,
	})
	const statusRequests: Array<{ cookie: string | null; authorization: string | null }> = []
	await page.route(
		(url) => url.hostname !== 'localhost',
		(route) => route.abort(),
	)
	await page.route('**/api/trpc/**', (route) =>
		route.fulfill({ status: 503, body: '' }),
	)
	await page.route(
		(url) =>
			url.hostname === 'localhost' &&
			url.pathname === '/api/evergreen/offer-status',
		async (route) => {
			const request = route.request()
			statusRequests.push({
				cookie: (await request.allHeaders()).cookie ?? null,
				authorization: (await request.allHeaders()).authorization ?? null,
			})
			const response = await handler(new Request(request.url()))
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.text(),
			})
		},
	)
	const answered = page.waitForResponse((response) =>
		response.url().includes('/api/evergreen/offer-status'),
	)
	await page.goto(`/?coupon=${encodeURIComponent(couponId)}`)
	await answered
	expect(await page.context().cookies()).toEqual([])
	expect(statusRequests).toEqual([{ cookie: null, authorization: null }])
	return { couponId }
}

const kitField = (issue: CouponIssuePayload, couponId: string) =>
	offerFieldsFor({
		couponId,
		payload: issue,
		origin: 'https://www.aihero.dev',
		deadlineFormat: 'absolute',
	})[EVERGREEN_OFFER_FIELD_KEYS.deadlineDisplay]

const principals = {
	berlin: offerPayload({
		expiresAt: '2026-10-05T21:59:59.000Z',
		timezone: 'Europe/Berlin',
		timezoneSource: 'vercel-header',
	}),
	fallback: offerPayload({
		expiresAt: '2026-10-06T06:59:59.000Z',
		timezone: 'America/Los_Angeles',
		timezoneSource: 'fallback',
	}),
}

for (const [name, issue] of Object.entries(principals)) {
	const shifted = (ms: number) =>
		new Date(Date.parse(issue.expiresAt) + ms).toISOString()

	test(`${name}: signed out, two minutes before expiry, the page says nothing`, async ({
		page,
	}) => {
		await openOfferLink(page, issue, shifted(-2 * 60_000))
		await expect(page.getByTestId('evergreen-offer-ended')).toHaveCount(0)
	})

	test(`${name}: signed out, after expiry, the page names the deadline the Kit field printed`, async ({
		page,
	}) => {
		const { couponId } = await openOfferLink(page, issue, shifted(1_000))
		const notice = page.getByTestId('evergreen-offer-ended')
		await expect(notice).toHaveText(
			`This private offer ended ${kitField(issue, couponId)}.`,
		)
		console.log(`[${name}] ${await notice.textContent()}`)
	})
}
