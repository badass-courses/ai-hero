import { MDXRemoteSerializeResult } from 'next-mdx-remote'

import { Coupon, Product, Purchase } from '@coursebuilder/core/schemas'
import { CommerceProps, PricingData } from '@coursebuilder/core/types'

export type WorkshopPageProps = {
	quantityAvailable: number
	product?: Product
	mdx?: MDXRemoteSerializeResult
	hasPurchasedCurrentProduct?: boolean
	availableBonuses: any[]
	existingPurchase?: (Purchase & { product?: Product | null }) | null
	purchases?: Purchase[]
	purchasedProductIds?: string[]
	userId?: string
	pricingDataLoader: Promise<PricingData>
	/** Active site-wide sale coupon for the product (e.g. launch intro price). */
	defaultCoupon?: Coupon | null
} & CommerceProps
