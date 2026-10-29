import { Effect } from 'effect'

import { issueIntentFor, type CouponIssuePayload } from './drovr-evergreen-coupon'
import {
	createCouponAuthority,
	type CommerceCouponRow,
	type CouponCommerceStore,
} from './evergreen-offer-journey/coupon-authority'

// Test fixtures: a coupon row exactly as the real authority writes it, with
// no database. The unit tests and the signed-out Playwright check share it.

const contactId = 'contact-status-fixture'

export const offerPayload = (
	overrides: Partial<CouponIssuePayload> = {},
): CouponIssuePayload => ({
	productId: 'product-ma254',
	amountOffCents: 10_000,
	maxUses: 1,
	exclusive: true,
	regularPriceCents: 29_900,
	effectivePriceCents: 19_900,
	issueAt: '2026-09-30T16:00:00.000Z',
	expiresAt: '2026-10-05T21:59:59.000Z',
	timezone: 'Europe/Berlin',
	timezoneSource: 'vercel-header',
	...overrides,
})

/** Issue through the real authority and keep the row it writes. */
export async function issuedRow(issue: CouponIssuePayload) {
	let stored: CommerceCouponRow | null = null
	const store: CouponCommerceStore = {
		withContactLock: (_id, work) =>
			work({
				lockedContact: { id: contactId, email: 'status@example.test' },
				getMerchantCoupon: async () => ({
					id: 'merchant-fixture',
					identifier: 'provider-fixture',
					merchantAccountId: 'account-fixture',
					organizationId: null,
					status: 1,
					amountDiscount: 10_000,
					percentageDiscount: null,
					type: 'special',
				}),
				getCoupon: async () => structuredClone(stored),
				insertCoupon: async (row) => {
					stored = structuredClone(row)
				},
				setCouponFields: async () => undefined,
				getUser: async () => null,
				getCreditTypeId: async () => 'credit-type-fixture',
				listCouponEntitlements: async () => [],
				insertEntitlement: async () => undefined,
			}),
	}
	const authority = createCouponAuthority({
		store,
		merchantCouponEvidence: {
			id: 'merchant-fixture',
			identifier: 'provider-fixture',
			merchantAccountId: 'account-fixture',
			currency: 'USD',
			amountOffCents: 10_000,
			type: 'special',
			sourceReference: 'fixture-readback',
		},
		now: () => issue.issueAt,
	})
	const receipt = await Effect.runPromise(
		authority.issue(issueIntentFor(contactId, issue)),
	)
	if (!stored) throw new Error('authority wrote no coupon row')
	return { row: stored as CommerceCouponRow, couponId: receipt.coupon.couponId }
}
