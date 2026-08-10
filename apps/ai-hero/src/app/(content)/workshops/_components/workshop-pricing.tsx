'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { api } from '@/trpc/react'

import { PriceCheckProvider } from '@coursebuilder/commerce-next/pricing/pricing-check-context'

import { useWorkshopNavigation } from './workshop-navigation-provider'
import type { WorkshopPageProps } from './workshop-page-props'
import { WorkshopPricingWidgetContainer } from './workshop-pricing-widget-container'

export function WorkshopPricingClient({
	product,
	quantityAvailable,
	pricingDataLoader,
	purchasedProductIds,
	hasPurchasedCurrentProduct,
	searchParams,
	className,
	...commerceProps
}: WorkshopPageProps & {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
	className?: string
}) {
	const teamQuantityLimit = 100
	const pathname = usePathname()
	const workshopNavigation = useWorkshopNavigation()
	const { status: sessionStatus } = useSession()
	const { data: personalizedCommerceProps } =
		api.pricing.propsForCommerce.useQuery(
			{ productId: product?.id },
			{
				enabled: sessionStatus === 'authenticated' && Boolean(product?.id),
				staleTime: 60_000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)
	const workshops =
		(workshopNavigation?.parents?.[0]?.resources &&
			workshopNavigation?.parents?.[0]?.resources.map((resource) => ({
				title: resource.resource.fields?.title,
				slug: resource.resource.fields?.slug,
			}))) ||
		[]

	const resolvedSearchParams = React.use(searchParams)
	const resolvedCommerceProps = {
		...commerceProps,
		...(personalizedCommerceProps ?? {}),
	}
	const resolvedPurchasedProductIds =
		resolvedCommerceProps.purchases?.map((purchase) => purchase.productId) ??
		purchasedProductIds
	const resolvedHasPurchased =
		hasPurchasedCurrentProduct ||
		Boolean(
			product &&
			resolvedCommerceProps.purchases?.some(
				(purchase) => purchase.productId === product.id,
			),
		)

	return product ? (
		<PriceCheckProvider purchasedProductIds={resolvedPurchasedProductIds}>
			<WorkshopPricingWidgetContainer
				className={className}
				product={product}
				quantityAvailable={quantityAvailable}
				pricingDataLoader={pricingDataLoader}
				hasPurchasedCurrentProduct={resolvedHasPurchased}
				searchParams={resolvedSearchParams}
				workshops={workshops}
				pathname={pathname}
				pricingWidgetOptions={{
					teamQuantityLimit,
				}}
				{...resolvedCommerceProps}
			/>
		</PriceCheckProvider>
	) : null
}
