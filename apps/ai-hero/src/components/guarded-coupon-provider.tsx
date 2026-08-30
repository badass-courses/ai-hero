'use client'

import * as React from 'react'

import { CouponProvider as CourseBuilderCouponProvider } from '@coursebuilder/commerce-next/coupons/coupon-context'

import { ignoreEmptyCouponLookup } from './coupon-lookup'

type CouponProviderProps = React.ComponentProps<
	typeof CourseBuilderCouponProvider
>

/**
 * Preserve Course Builder coupon handling without invoking its server action
 * for the common case where the URL contains no coupon code.
 */
export function GuardedCouponProvider({
	getCouponForCode,
	...props
}: CouponProviderProps) {
	const guardedLookup = React.useMemo(
		() => ignoreEmptyCouponLookup(getCouponForCode),
		[getCouponForCode],
	)

	return (
		<CourseBuilderCouponProvider
			{...props}
			getCouponForCode={guardedLookup}
		/>
	)
}
