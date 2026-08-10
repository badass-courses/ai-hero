'use client'

import { useSearchParams } from 'next/navigation'
import { PricingWidget } from '@/components/commerce/home-pricing-widget'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

import type { Product } from '@coursebuilder/core/schemas'
import type { CommerceProps, PricingData } from '@coursebuilder/core/types'

import { readCommerceUrlParams } from './commerce-url-params'

type WorkshopsIndexPricingProps = {
	product: Product
	initialCommerceProps: CommerceProps
	pricingData: PricingData
	initialAllowPurchase?: boolean
}

export function WorkshopsIndexPricing({
	product,
	initialCommerceProps,
	pricingData,
	initialAllowPurchase = true,
}: WorkshopsIndexPricingProps) {
	const searchParams = useSearchParams()
	const {
		params: commerceUrlParams,
		hasCommerceParams,
		forceAllowPurchase,
	} = readCommerceUrlParams(searchParams)
	const { status: sessionStatus } = useSession()
	const { data: personalizedCommerceProps } =
		api.pricing.propsForCommerce.useQuery(
			{ ...commerceUrlParams, productId: product.id },
			{
				enabled: sessionStatus === 'authenticated' || hasCommerceParams,
				staleTime: 60_000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)
	const commerceProps = personalizedCommerceProps ?? initialCommerceProps

	if (!initialAllowPurchase && !forceAllowPurchase) return null

	return (
		<WorkshopsIndexPricingView
			product={product}
			pricingData={pricingData}
			commerceProps={commerceProps}
		/>
	)
}

export function WorkshopsIndexPricingFallback({
	product,
	initialCommerceProps,
	pricingData,
	initialAllowPurchase = true,
}: WorkshopsIndexPricingProps) {
	if (!initialAllowPurchase) return null

	return (
		<WorkshopsIndexPricingView
			product={product}
			pricingData={pricingData}
			commerceProps={initialCommerceProps}
		/>
	)
}

function WorkshopsIndexPricingView({
	product,
	pricingData,
	commerceProps,
}: {
	product: Product
	pricingData: PricingData
	commerceProps: CommerceProps
}) {
	const hasPurchased = Boolean(
		commerceProps.purchases?.some(
			(purchase) => purchase.productId === product.id,
		),
	)

	return (
		<section id="buy" className="mt-16">
			{!hasPurchased && (
				<h2 className="mb-10 text-balance px-5 text-center text-2xl font-bold">
					Get Access Today
				</h2>
			)}
			<div className="flex items-center justify-center border-y">
				<div className="bg-background flex w-full max-w-md flex-col border-x p-8">
					<PricingWidget
						quantityAvailable={pricingData.quantityAvailable}
						pricingDataLoader={Promise.resolve(pricingData)}
						commerceProps={commerceProps}
						product={product}
					/>
				</div>
			</div>
		</section>
	)
}
