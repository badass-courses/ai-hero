'use client'

import { PricingWidget } from '@/components/commerce/home-pricing-widget'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

import type { Product } from '@coursebuilder/core/schemas'
import type { CommerceProps, PricingData } from '@coursebuilder/core/types'

export function WorkshopsIndexPricing({
	product,
	initialCommerceProps,
	pricingData,
}: {
	product: Product
	initialCommerceProps: CommerceProps
	pricingData: PricingData
}) {
	const { status: sessionStatus } = useSession()
	const { data: personalizedCommerceProps } =
		api.pricing.propsForCommerce.useQuery(
			{ productId: product.id },
			{
				enabled: sessionStatus === 'authenticated',
				staleTime: 60_000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)
	const commerceProps = personalizedCommerceProps ?? initialCommerceProps
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
