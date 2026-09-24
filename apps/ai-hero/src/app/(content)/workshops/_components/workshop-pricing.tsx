'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { api } from '@/trpc/react'

import { PriceCheckProvider } from '@coursebuilder/commerce-next/pricing/pricing-check-context'

import {
	readCommerceUrlParams,
	type CommerceUrlParams,
} from './commerce-url-params'
import { InlineBuyButton } from './inline-mdx-pricing'
import { useWorkshopNavigation } from './workshop-navigation-provider'
import type { WorkshopPageProps } from './workshop-page-props'
import { WorkshopPricingWidgetContainer } from './workshop-pricing-widget-container'

type WorkshopPricingProps = WorkshopPageProps & {
	className?: string
	/** The workshop's team page, when it has one. */
	teamOptionsHref?: string
	/** Render as the team checkout (seats on, no side-links). */
	teamMode?: boolean
}

function useWorkshopCommerce(productId?: string) {
	const searchParams = useSearchParams()
	const { params: commerceUrlParams, hasCommerceParams } =
		readCommerceUrlParams(searchParams)
	const { status: sessionStatus } = useSession()
	const { data, isError } = api.pricing.propsForCommerce.useQuery(
		{ ...commerceUrlParams, productId },
		{
			enabled:
				Boolean(productId) &&
				(sessionStatus === 'authenticated' || hasCommerceParams),
			staleTime: 60_000,
			refetchOnWindowFocus: false,
			retry: 1,
		},
	)
	return {
		commerceUrlParams,
		hasCommerceParams,
		checkingCoupon: Boolean(commerceUrlParams.code || commerceUrlParams.coupon),
		data,
		isError,
	}
}

export function WorkshopPricingClient(props: WorkshopPricingProps) {
	const { commerceUrlParams, checkingCoupon, data, isError } =
		useWorkshopCommerce(props.product?.id)
	// This static shell renders before the uncached coupon read. Do not offer a
	// full-price checkout while a URL coupon is still being verified.
	if (checkingCoupon && !data) {
		return (
			<p role="status" className="px-[18px] py-12 sm:px-11">
				{isError
					? 'Could not check this coupon. Reload to try again.'
					: 'Checking your coupon…'}
			</p>
		)
	}
	return (
		<WorkshopPricingView
			{...props}
			{...(data ?? {})}
			searchParams={commerceUrlParams}
		/>
	)
}

// Inline MDX buy buttons also render in the static shell. Give them the same
// uncached coupon read as the sidebar, instead of leaving misleading $299 CTAs.
export function WorkshopInlineBuyButton(
	props: React.ComponentProps<typeof InlineBuyButton>,
) {
	const { checkingCoupon, data, isError } = useWorkshopCommerce(
		props.pricingProps?.products?.[0]?.id,
	)
	if (checkingCoupon && !data) {
		return (
			<p role="status" className="py-4">
				{isError
					? 'Could not check this coupon. Reload to try again.'
					: 'Checking your coupon…'}
			</p>
		)
	}
	return (
		<InlineBuyButton
			{...props}
			pricingProps={{ ...props.pricingProps, ...(data ?? {}) }}
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
	teamOptionsHref,
	teamMode,
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
				teamOptionsHref={teamOptionsHref}
				teamMode={teamMode}
				pricingWidgetOptions={{
					teamQuantityLimit,
				}}
				{...commerceProps}
			/>
		</PriceCheckProvider>
	) : null
}
