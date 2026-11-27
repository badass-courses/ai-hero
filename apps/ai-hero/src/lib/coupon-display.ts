import {
	getCouponForCode as coreGetCouponForCode,
	propsForCommerce as corePropsForCommerce,
} from '@coursebuilder/commerce/props-for-commerce'

import { couponDisplayView } from './paid-coupon-pricing-view'

export type { PropsForCommerce } from '@coursebuilder/commerce/props-for-commerce'

export const getCouponForCode: typeof coreGetCouponForCode = (
	code,
	products,
	adapter,
) => coreGetCouponForCode(code, products, couponDisplayView(adapter))

export const propsForCommerce: typeof corePropsForCommerce = (input, adapter) =>
	corePropsForCommerce(input, couponDisplayView(adapter))
