'use client'

import React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import Spinner from '@/components/spinner'
import { env } from '@/env.mjs'
import type { Cohort } from '@/lib/cohort'
import type { Event } from '@/lib/events'
import type { MinimalWorkshop, Workshop } from '@/lib/workshops'
import { api } from '@/trpc/react'
import { formatInTimeZone } from 'date-fns-tz'
import { BadgeCheck, ExternalLink } from 'lucide-react'
import { type CountdownRenderProps } from 'react-countdown'

import { CouponContext } from '@coursebuilder/commerce-next/coupons/coupon-context'
import { useCoupon } from '@coursebuilder/commerce-next/coupons/use-coupon'
import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { PriceCheckProvider } from '@coursebuilder/commerce-next/pricing/pricing-check-context'
import { usePricing } from '@coursebuilder/commerce-next/pricing/pricing-context'
import type { PropsForCommerce } from '@coursebuilder/core/lib/pricing/props-for-commerce'
import { Product, Purchase } from '@coursebuilder/core/schemas'
import type {
	CommerceProps,
	FormattedPrice,
	PricingOptions,
} from '@coursebuilder/core/types'
import { formatUsd } from '@coursebuilder/core/utils/format-usd'
import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { WORKSHOP_CTA_BUTTON } from './workshop-notify-button'

export type PricingData = {
	formattedPrice?: FormattedPrice | null
	purchaseToUpgrade?: Purchase | null
	quantityAvailable: number
}

export type PricingComponentProps = {
	product: Product
	quantityAvailable: number
	commerceProps: CommerceProps
	pricingDataLoader: Promise<PricingData>
	hasPurchasedCurrentProduct?: boolean
	pricingWidgetOptions?: Partial<PricingOptions>
	centered?: boolean
	resourceType: string
	className?: string
	/**
	 * When set, a slim regional-pricing strip renders alongside the buy button
	 * (anchored to the nearest positioned ancestor — the mobile bottom bar) and
	 * taps scroll to this element id. Mobile-bar only: on desktop the buy box
	 * itself carries the regional-pricing checkbox.
	 */
	regionalPricingNoteTargetId?: string
}

/**
 * Buy ticket button only
 */
export const BuyButtonComponent: React.FC<
	PricingComponentProps & { centered?: boolean; resourceType: string }
> = ({
	product,
	commerceProps,
	pricingDataLoader,
	pricingWidgetOptions,
	hasPurchasedCurrentProduct,
	centered,
	className,
	resourceType,
	regionalPricingNoteTargetId,
}) => {
	const couponFromCode = commerceProps?.couponFromCode
	const { validCoupon } = useCoupon(couponFromCode)
	const couponId =
		commerceProps?.couponIdFromCoupon ||
		(validCoupon ? couponFromCode?.id : undefined)

	return hasPurchasedCurrentProduct ? (
		<PurchasedTicketInfo centered={centered} resourceType={resourceType} />
	) : (
		<Pricing.Root
			className={cn('flex items-start justify-start')}
			product={product}
			couponId={couponId}
			options={pricingWidgetOptions}
			userId={commerceProps?.userId}
			pricingDataLoader={pricingDataLoader}
		>
			<Pricing.Product>
				<Buy
					resourceType={resourceType}
					className={className}
					centered={centered}
				/>
				{regionalPricingNoteTargetId && (
					<RegionalPricingNote targetId={regionalPricingNoteTargetId} />
				)}
			</Pricing.Product>
		</Pricing.Root>
	)
}

/**
 * One-line regional-pricing notice for the mobile bottom bar. The desktop buy
 * box explains PPP with a checkbox and the from-country restriction, but a
 * phone visitor only ever meets the bar — so eligible visitors emailed support
 * asking whether regional pricing exists at all. This surfaces the answer
 * without owning the decision: tapping scrolls to the buy box, where the
 * checkbox and the restriction copy (a condition of the discount) live.
 *
 * Renders nothing unless a PPP coupon is actually available for this visitor
 * and not already applied (an applied coupon is visible in the button price).
 */
const RegionalPricingNote = ({ targetId }: { targetId: string }) => {
	const { formattedPrice, activeMerchantCoupon } = usePricing()

	const availablePPPCoupon = Array.isArray(formattedPrice?.availableCoupons)
		? formattedPrice.availableCoupons.find((coupon) => coupon?.type === 'ppp')
		: undefined
	if (!availablePPPCoupon || activeMerchantCoupon?.type === 'ppp') return null

	const rawDiscount = availablePPPCoupon.percentageDiscount as
		| string
		| number
		| { toNumber?: () => number }
		| undefined
	const percentOff = Math.floor(
		(typeof rawDiscount === 'string'
			? Number(rawDiscount)
			: typeof rawDiscount === 'number'
				? rawDiscount
				: (rawDiscount?.toNumber?.() ?? 0)) * 100,
	)

	// Same guard as the buy box: `Intl.DisplayNames.of` throws on a structurally
	// invalid region code, and this code is stored coupon data.
	const rawCountryCode = availablePPPCoupon.country || 'US'
	const countryCode = /^[A-Za-z]{2}$/.test(rawCountryCode)
		? rawCountryCode.toUpperCase()
		: 'US'
	const country =
		new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ??
		countryCode

	return (
		<button
			type="button"
			data-regional-note=""
			onClick={() => {
				document
					.getElementById(targetId)
					?.scrollIntoView({ behavior: 'smooth', block: 'start' })
			}}
			// Anchored to the bar's bottom edge as a second row under title+button;
			// the bar reserves this row's height via its `has-[[data-regional-note]]`
			// padding — the two must move together.
			className="border-border absolute bottom-0 left-0 w-full cursor-pointer border-t px-3 py-1.5 text-left"
		>
			<span
				className={cn(TYPE.metaSm, 'text-muted-foreground text-pretty')}
			>
				{/* Rhymes with the buy box's "Buying from {country}?" sentence so the
				    tap lands on familiar words. */}
				Buying from{' '}
				<strong className="text-foreground font-semibold">{country}</strong>?{' '}
				{percentOff}% off regional pricing is available&nbsp;→
			</span>
		</button>
	)
}

const Buy = ({
	centered,
	resourceType,
	className,
}: {
	centered?: boolean
	resourceType: string
	className?: string
}) => {
	const {
		formattedPrice,
		status,
		product,
		pricingData: { quantityAvailable },
		isSoldOut,
	} = usePricing()
	const fullPrice = formattedPrice?.fullPrice || 0

	const finalPrice = formattedPrice?.calculatedPrice || 0
	const savings = fullPrice - finalPrice
	const savingsPercentage = Math.round((savings / fullPrice) * 100)

	// The house gold CTA with the price riding along in mono — the button and
	// the number it commits you to are one object (`Workshop Landing.dc.html`
	// § "Mobile bottom bar"). The blue fill and the animated shine are gone:
	// the site has one accent and it is not blue, and permanent motion is not
	// how a resting button earns attention (DESIGN rules 7 and 13).
	return (
		<Pricing.BuyButton className={cn(WORKSHOP_CTA_BUTTON, className)}>
			<span data-label="">Buy Now</span>
			<span data-divider="" className="bg-accent-fill-foreground/25 mx-2.5 h-4 w-px" />
			<span className="flex items-baseline font-mono text-[13px] font-medium">
				{status === 'pending' ? (
					<Spinner className="size-4" />
				) : (
					<>
						<span className="tabular-nums">{formatUsd(finalPrice).dollars}</span>
						{savings > 0 && !isSoldOut && (
							<span className="ml-1.5 font-normal line-through opacity-60">
								{formatUsd(fullPrice).dollars}
							</span>
						)}
					</>
				)}
			</span>
		</Pricing.BuyButton>
	)
}

/**
 * Higher-order component that provides common pricing functionality
 * and data handling, while allowing for different pricing UI variations
 */
export const withEventPricing = (
	PricingComponent: React.ComponentType<PricingComponentProps>,
) => {
	return function WithEventPricing({
		pricingProps,
		resource,
		pricingOptions,
		pricingDataLoader,
		centered = false,
		resourceType,
		className,
		regionalPricingNoteTargetId,
	}: {
		pricingProps: PropsForCommerce
		resource: Cohort | MinimalWorkshop
		pricingOptions?: Partial<PricingOptions>
		pricingDataLoader: Promise<PricingData>
		centered?: boolean
		resourceType: string
		className?: string
		regionalPricingNoteTargetId?: string
	}) {
		const { coupon } = React.useContext(CouponContext)

		if (!pricingProps) {
			return null
		}

		const commerceProps = {
			...pricingProps,
			couponFromCode: coupon,
			couponIdFromCoupon: coupon?.id,
		}

		const purchasedProductIds =
			commerceProps?.purchases?.map((purchase) => purchase.productId) || []

		const product = pricingProps.products[0]

		if (!product || product.status !== 1) return null

		if (product.fields?.state !== 'published') return null

		const defaultPricingOptions = {
			withTitle: true,
			withImage: false,
			withGuaranteeBadge: false,
			isLiveEvent: true,
			teamQuantityLimit:
				product.quantityAvailable >= 0 && product.quantityAvailable > 5
					? 5
					: product.quantityAvailable < 0
						? 100
						: product.quantityAvailable,
			isPPPEnabled: true,
			cancelUrl: `${env.NEXT_PUBLIC_URL}/${getResourcePath(resourceType, resource?.fields?.slug, 'view')}`,
			...pricingOptions,
		}
		const { openEnrollment, closeEnrollment } = product?.fields || {}
		const { startsAt, endsAt, timezone } = resource?.fields
		const tz = timezone || 'America/Los_Angeles'
		const nowInPT = new Date(
			formatInTimeZone(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
		)
		const isOpenEnrollment = openEnrollment
			? new Date(openEnrollment) < nowInPT &&
				(closeEnrollment ? new Date(closeEnrollment) > nowInPT : true)
			: false

		// Check if enrollment hasn't opened yet
		const enrollmentNotOpenYet = openEnrollment
			? new Date(openEnrollment) > nowInPT
			: false

		// Check if cohort has actually started (different from enrollment status)
		const hasStarted = startsAt ? new Date(startsAt) <= nowInPT : false

		const hasPurchasedCurrentProduct = commerceProps?.purchases?.some(
			(purchase) => purchase.productId === product.id,
		)

		return (
			<PriceCheckProvider purchasedProductIds={purchasedProductIds}>
				{hasStarted ? (
					<div className="font-heading flex w-full items-center justify-center py-5 text-lg font-medium">
						The Cohort Has Started
					</div>
				) : (
					<PricingComponent
						centered={centered}
						resourceType={resourceType}
						hasPurchasedCurrentProduct={hasPurchasedCurrentProduct}
						commerceProps={commerceProps}
						product={product}
						quantityAvailable={product.quantityAvailable}
						pricingDataLoader={pricingDataLoader}
						pricingWidgetOptions={defaultPricingOptions}
						className={className}
						regionalPricingNoteTargetId={regionalPricingNoteTargetId}
					/>
				)}
			</PriceCheckProvider>
		)
	}
}

const PurchasedTicketInfo = ({
	centered,
	resourceType,
}: {
	centered?: boolean
	resourceType: string
}) => {
	return (
		<div
			className={cn(
				'bg-primary/10 not-prose inline-flex flex-wrap items-center gap-1.5 rounded-md p-4 text-base sm:justify-start sm:text-lg',
				centered && 'justify-center',
			)}
		>
			<div className="inline-flex items-baseline gap-2 sm:items-center">
				<BadgeCheck className="text-primary size-4 flex-shrink-0 sm:size-5" />
				<p className="text-primary">
					{resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}{' '}
					purchased. We sent the details of the cohort to your email.{' '}
					<Link
						target="_blank"
						href="/invoices"
						className="underline-offset-2 hover:underline"
					>
						<span className="inline-flex items-center gap-1 underline">
							Get Invoice
							<ExternalLink className="size-4" />
						</span>
					</Link>
				</p>
			</div>
		</div>
	)
}

/**
 * Pre-configured event pricing components using the HOC
 */

export const InlineBuyButton = withEventPricing(BuyButtonComponent)
