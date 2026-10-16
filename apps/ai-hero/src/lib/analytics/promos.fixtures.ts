import type { CouponFacts, PromoKind, PromoPurchase } from './promos'

export type PromoCase = {
	name: string
	purchase: PromoPurchase
	facts: CouponFacts
	kind: PromoKind
}
const paid = { status: 'Valid', totalAmount: '25.50' }
const coupon = { couponId: 'synthetic-coupon' }
export const promoCases: PromoCase[] = [
	{ name: 'no coupon', purchase: paid, facts: {}, kind: 'full-price' },
	{
		name: 'empty dangling coupon reference',
		purchase: { ...paid, couponId: '' },
		facts: {},
		kind: 'unclassified',
	},
	{
		name: 'empty redemption reference is not null',
		purchase: { ...paid, redeemedBulkCouponId: '' },
		facts: {},
		kind: 'seat-or-zero',
	},
	{
		name: 'regional without coupon',
		purchase: { ...paid, status: 'Restricted' },
		facts: {},
		kind: 'regional',
	},
	{
		name: 'site coupon',
		purchase: { ...paid, ...coupon },
		facts: { siteCouponFound: true },
		kind: 'other-coupon',
	},
	{
		name: 'merchant coupon',
		purchase: { ...paid, ...coupon },
		facts: { merchantCouponFound: true, merchantCouponType: 'special' },
		kind: 'other-coupon',
	},
	{
		name: 'bulk merchant coupon',
		purchase: paid,
		facts: { merchantCouponFound: true },
		kind: 'other-coupon',
	},
	{
		name: 'future merchant type remains a coupon',
		purchase: { ...paid, ...coupon },
		facts: { merchantCouponFound: true, merchantCouponType: 'future-type' },
		kind: 'other-coupon',
	},
	{
		name: 'dangling coupon',
		purchase: { ...paid, ...coupon },
		facts: {},
		kind: 'unclassified',
	},
	{
		name: 'unrelated evergreen facts',
		purchase: paid,
		facts: { siteCouponFound: true, fields: { evergreenOffer: {} } },
		kind: 'full-price',
	},
	{
		name: 'zero beats coupon',
		purchase: { ...paid, ...coupon, totalAmount: 0 },
		facts: { siteCouponFound: true, fields: { evergreenOffer: {} } },
		kind: 'seat-or-zero',
	},
	{
		name: 'seat beats paid evergreen',
		purchase: { ...paid, ...coupon, redeemedBulkCouponId: 'synthetic-team' },
		facts: { siteCouponFound: true, fields: { evergreenOffer: {} } },
		kind: 'seat-or-zero',
	},
	{
		name: 'unknown status',
		purchase: { ...paid, status: 'FutureStatus' },
		facts: {},
		kind: 'unclassified',
	},
	{
		name: 'banned evergreen',
		purchase: { ...paid, ...coupon, status: 'Banned' },
		facts: { siteCouponFound: true, fields: { evergreenOffer: {} } },
		kind: 'unclassified',
	},
	{
		name: 'pending',
		purchase: { ...paid, status: 'Pending' },
		facts: {},
		kind: 'unclassified',
	},
	{
		name: 'negative',
		purchase: { ...paid, totalAmount: -2 },
		facts: {},
		kind: 'unclassified',
	},
	...['Valid', 'Restricted', 'Refunded'].flatMap((status): PromoCase[] => [
		...[{}, null, false, ''].map(
			(evergreenOffer): PromoCase => ({
				name: `${status} evergreen presence ${JSON.stringify(evergreenOffer)}`,
				purchase: { ...paid, ...coupon, status },
				facts: { siteCouponFound: true, fields: { evergreenOffer } },
				kind: 'evergreen',
			}),
		),
		{
			name: `${status} ordinary coupon`,
			purchase: { ...paid, ...coupon, status },
			facts: { siteCouponFound: true, fields: {} },
			kind: status === 'Restricted' ? 'regional' : 'other-coupon',
		},
		{
			name: `${status} no coupon`,
			purchase: { ...paid, status },
			facts: {},
			kind: status === 'Restricted' ? 'regional' : 'full-price',
		},
		{
			name: `${status} merchant PPP`,
			purchase: { ...paid, ...coupon, status },
			facts: { merchantCouponFound: true, merchantCouponType: 'ppp' },
			kind: 'regional',
		},
		{
			name: `${status} zero`,
			purchase: { ...paid, status, totalAmount: '0.00' },
			facts: {},
			kind: 'seat-or-zero',
		},
	]),
]
