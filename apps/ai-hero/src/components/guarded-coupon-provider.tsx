'use client'

import * as React from 'react'
import { use } from 'react'

import { CouponContext } from '@coursebuilder/commerce-next/coupons/coupon-context'
import type { CouponProvider as CourseBuilderCouponProvider } from '@coursebuilder/commerce-next/coupons/coupon-context'
import RedeemDialog from '@coursebuilder/commerce-next/pricing/redeem-dialog'

import { ignoreEmptyCouponLookup } from './coupon-lookup'

type CouponProviderProps = React.ComponentProps<
	typeof CourseBuilderCouponProvider
>

/**
 * Course Builder's `CouponProvider`, minus its `SessionProvider`, plus the
 * guard that skips the server action when the URL carries no coupon code.
 *
 * The upstream provider wraps its children in a second `SessionProvider`.
 * The root layout already has one, and next-auth's provider refetches the
 * session when it hears its own broadcast, so two of them on every page made
 * six `/api/auth/session` requests per view and a second provider tree to
 * hydrate. Everything under the root provider — including `RedeemDialog`'s
 * `useSession` — reads the root session instead.
 *
 * The coupon logic itself is the upstream code, line for line, so
 * `useCoupon` and the pricing widgets see the same `CouponContext` value.
 */
export function GuardedCouponProvider({
	children,
	getProduct,
	getCouponForCode,
}: CouponProviderProps) {
	const guardedLookup = React.useMemo(
		() => ignoreEmptyCouponLookup(getCouponForCode),
		[getCouponForCode],
	)
	const [couponLoader, setCouponLoader] =
		React.useState<ReturnType<typeof guardedLookup>>()
	const [productLoader, setProductLoader] =
		React.useState<ReturnType<typeof getProduct>>()

	React.useEffect(() => {
		const searchParams = new URLSearchParams(window.location.search)
		const codeParam = searchParams.get('code')
		const couponParam = searchParams.get('coupon')
		setCouponLoader(guardedLookup(codeParam || couponParam))
	}, [guardedLookup])

	const coupon = couponLoader ? use(couponLoader) : undefined
	const validCoupon = Boolean(coupon && coupon.isValid)

	React.useEffect(() => {
		if (coupon?.isValid) {
			// Upstream passes the id through unchecked; keep that behavior.
			setProductLoader(getProduct(coupon.restrictedToProductId as string))
		}
	}, [coupon?.restrictedToProductId, coupon?.isValid, getProduct])

	const product = productLoader ? use(productLoader) : undefined
	const isRedeemable = validCoupon && product && coupon?.isRedeemable

	return (
		<CouponContext.Provider value={{ coupon }}>
			{isRedeemable && (
				<RedeemDialog
					open={validCoupon}
					couponId={coupon?.id}
					product={product}
				/>
			)}
			{children}
		</CouponContext.Provider>
	)
}
