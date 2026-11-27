import {
	getCouponForCode as coreGetCouponForCode,
	propsForCommerce as corePropsForCommerce,
} from '@coursebuilder/commerce/props-for-commerce'

import { inRowNamespace } from './coupon-batches/selector'
import { couponDisplayView } from './paid-coupon-pricing-view'

const selectorDisplay = <T extends Parameters<typeof coreGetCouponForCode>[2]>(
	adapter: T,
) => {
	const display = couponDisplayView(adapter)
	const read = display.getCoupon.bind(display)
	return Object.assign(display, {
		getCoupon: (key: string) =>
			inRowNamespace(key) ? Promise.resolve(null) : read(key),
	})
}

export type { PropsForCommerce } from '@coursebuilder/commerce/props-for-commerce'

export const getCouponForCode: typeof coreGetCouponForCode = (
	code,
	products,
	adapter,
) => coreGetCouponForCode(code, products, selectorDisplay(adapter))

export const propsForCommerce: typeof corePropsForCommerce = (input, adapter) =>
	corePropsForCommerce(input, selectorDisplay(adapter))
