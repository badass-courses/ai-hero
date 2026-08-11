'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { api } from '@/trpc/react'

import { PriceCheckProvider } from '@coursebuilder/commerce-next/pricing/pricing-check-context'

import {
	readCommerceUrlParams,
	type CommerceUrlParams,
} from './commerce-url-params'
import { useWorkshopNavigation } from './workshop-navigation-provider'
import type { WorkshopPageProps } from './workshop-page-props'
import { WorkshopPricingWidgetContainer } from './workshop-pricing-widget-container'

type WorkshopPricingProps = WorkshopPageProps & { className?: string }

export function WorkshopPricingClient(props: WorkshopPricingProps) {
	const searchParams = useSearchParams()
	const { params: commerceUrlParams, hasCommerceParams } =
		readCommerceUrlParams(searchParams)
	const { status: sessionStatus } = useSession()
	const { data: personalizedCommerceProps } =
		api.pricing.propsForCommerce.useQuery(
			{ ...commerceUrlParams, productId: props.product?.id },
			{
				enabled:
					Boolean(props.product?.id) &&
					(sessionStatus === 'authenticated' || hasCommerceParams),
				staleTime: 60_000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)

	return (
		<WorkshopPricingView
			{...props}
			{...(personalizedCommerceProps ?? {})}
			searchParams={commerceUrlParams}
		/>
	)
}

export function WorkshopPricingFallback({
	searchParams = {},
	...props
}: WorkshopPricingProps & { searchParams?: CommerceUrlParams }) {
	return <WorkshopPricingView {...props} searchParams={searchParams} />
}

function WorkshopPricingView({
	product,
	quantityAvailable,
	pricingDataLoader,
	purchasedProductIds,
	hasPurchasedCurrentProduct,
	searchParams,
	className,
	...commerceProps
}: WorkshopPricingProps & { searchParams: CommerceUrlParams }) {
	const teamQuantityLimit = 100
	const pathname = usePathname()
	const workshopNavigation = useWorkshopNavigation()
	const workshops =
		(workshopNavigation?.parents?.[0]?.resources &&
			workshopNavigation?.parents?.[0]?.resources.map((resource) => ({
				title: resource.resource.fields?.title,
				slug: resource.resource.fields?.slug,
			}))) ||
		[]

	const resolvedPurchasedProductIds =
		commerceProps.purchases?.map((purchase) => purchase.productId) ??
		purchasedProductIds
	const resolvedHasPurchased =
		hasPurchasedCurrentProduct ||
		Boolean(
			product &&
			commerceProps.purchases?.some(
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
				searchParams={searchParams}
				workshops={workshops}
				pathname={pathname}
				pricingWidgetOptions={{
					teamQuantityLimit,
				}}
				{...commerceProps}
			/>
		</PriceCheckProvider>
	) : null
}
