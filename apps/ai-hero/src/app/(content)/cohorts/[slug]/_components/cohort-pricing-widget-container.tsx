'use client'

import type { ParsedUrlQuery } from 'querystring'
import * as React from 'react'
import { PricingWidget } from '@/app/(content)/workshops/_components/pricing-widget'
import { CldImage } from '@/components/cld-image'
import { CheckoutSurveyBuyButton } from '@/components/commerce/checkout-survey-buy-button'
import type { ProductPricingFeature } from '@/components/commerce/product-pricing-features'
import { SubscribeToConvertkitForm } from '@/convertkit'
import { env } from '@/env.mjs'
import type { CohortPageProps } from '@/lib/cohort'
import { track } from '@/utils/analytics'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { formatInTimeZone } from 'date-fns-tz'
import { toSnakeCase } from 'drizzle-orm/casing'
import { CheckCircle, Sparkles } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

export const CohortPricingWidgetContainer: React.FC<
	CohortPageProps & {
		className?: string
		searchParams?: ParsedUrlQuery
		enrollmentOpenDateString?: string | null
	}
> = ({ className, searchParams, enrollmentOpenDateString, ...props }) => {
	const {
		cohort,
		mdx,
		products,
		quantityAvailable,
		purchaseCount,
		totalQuantity,
		pricingDataLoader,
		hasPurchasedCurrentProduct,
		pricingWidgetOptions,
		couponFromCode,
		...commerceProps
	} = props
	const { fields } = cohort
	const { startsAt, endsAt, timezone } = fields
	const product = products && products[0]
	const { openEnrollment, closeEnrollment } = product?.fields || {}
	const { allowPurchase } = searchParams || {}

	// Properly handle timezone comparison - get current time in PT to compare with PT stored date
	const tz = timezone || 'America/Los_Angeles'
	const nowInPT = new Date(
		formatInTimeZone(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
	)
	const isUpcoming = startsAt ? new Date(startsAt) > nowInPT : false

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

	const workshops = cohort?.resources?.map(({ resource }) => ({
		title: resource.fields.title,
		slug: resource.fields.slug,
	}))
	const cohortPrependFeatures = React.useMemo<
		ProductPricingFeature[] | undefined
	>(() => {
		if (product?.type !== 'cohort') return undefined
		if (
			product?.fields?.slug !==
			'autonomous-ai-agents-live-workshop-ticket-qocpc'
		)
			return undefined

		return [
			{
				icon: <Sparkles className="h-4 w-4" />,
				label: 'AI SDK v6 Crash Course',
			},
		]
	}, [product?.fields?.slug, product?.type])
	const waitlistCkFields = {
		// example: waitlist_mcp_workshop_ticket: "2025-04-17"
		[`waitlist_${toSnakeCase(product?.name || '')}`]: new Date()
			.toISOString()
			.slice(0, 10),
	}

	const { dateString: eventDateString, timeString: eventTimeString } =
		formatCohortDateRange(startsAt, endsAt, timezone)

	// Determine the current state and messaging
	const getEnrollmentState = () => {
		if (couponFromCode?.fields?.bypassSoldOut === true) {
			return { type: 'open' as const }
		}
		if (isOpenEnrollment) {
			return { type: 'open' as const }
		}
		if (enrollmentNotOpenYet) {
			return {
				type: 'not-open' as const,
				title: `Enrollment opens ${enrollmentOpenDateString}`,
				subtitle: 'Join the waitlist to be notified when enrollment opens.',
			}
		}
		// Enrollment is closed
		return {
			type: 'closed' as const,
			title: hasStarted
				? 'This cohort has already started'
				: 'Enrollment is closed',
			subtitle: hasStarted
				? 'You can still join the waitlist to be notified when the next cohort starts.'
				: 'Enrollment has closed for this cohort. Join the waitlist to be notified when the next cohort starts.',
		}
	}

	const enrollmentState = getEnrollmentState()

	// Shared components
	const renderImage = () => {
		if (!pricingWidgetOptions?.withImage) return null
		const imageSrc = fields.image
		if (!imageSrc) return null
		return (
			<div className="mb-3 flex w-full items-center justify-center">
				<CldImage
					loading="lazy"
					src={imageSrc}
					alt={fields.title}
					width={383}
					height={204}
					className="rounded-lg"
				/>
			</div>
		)
	}

	const renderWaitlistForm = () => (
		<SubscribeToConvertkitForm
			fields={waitlistCkFields}
			actionLabel="Join Waitlist"
			className="w-full relative z-10 mt-5 flex flex-col items-center justify-center gap-2 [&_button]:mt-1 [&_button]:h-12 [&_button]:w-full [&_button]:text-base [&_input]:h-12 [&_input]:text-lg"
			successMessage={
				<p className="inline-flex items-center text-center text-lg font-medium">
					<CheckCircle className="text-primary mr-2 size-5" /> You are on the
					waitlist
				</p>
			}
			onSuccess={(subscriber, email) => {
				const handleOnSuccess = (subscriber: any) => {
					if (subscriber && product) {
						track('waitlist_joined', {
							product_name: product.name,
							product_id: product.id,
							email: email,
						})

						return subscriber
					}
				}
				handleOnSuccess(subscriber)
			}}
		/>
	)

	if (!product || product.status !== 1) {
		return null
	}

	return (
		<>
			{enrollmentState.type === 'open' || allowPurchase ? (
				<div className={cn('px-5 pb-5', className)}>
					{renderImage()}
					<p className="opacit-50 -mb-7 flex w-full items-center justify-center pt-5 text-center text-base">
						{eventDateString}
					</p>
					<PricingWidget
						className="border-b-0"
						workshops={workshops}
						product={product}
						quantityAvailable={quantityAvailable}
						commerceProps={commerceProps}
						pricingDataLoader={pricingDataLoader}
						prependFeatures={cohortPrependFeatures}
						buyButton={
							<CheckoutSurveyBuyButton className="bg-primary dark:bg-primary relative mt-3 h-16 max-w-xs cursor-pointer overflow-hidden rounded-xl text-lg font-semibold shadow-xl hover:brightness-110">
								<span className="relative z-10">Enroll</span>
								<div
									style={{
										backgroundSize: '200% 100%',
									}}
									className="animate-shine absolute inset-0 bg-[linear-gradient(120deg,transparent_40%,var(--primary-foreground)_50%,transparent_60%)] opacity-10 dark:opacity-20"
								/>
							</CheckoutSurveyBuyButton>
						}
						pricingWidgetOptions={{
							cancelUrl: `${env.NEXT_PUBLIC_URL}/cohorts/${cohort.fields.slug}`,
							isCohort: true,
							isLiveEvent: true,
							withImage: false,
							withTitle: false,
							...pricingWidgetOptions,
						}}
					/>
				</div>
			) : (
				<>
					{renderImage()}
					<p className="opacit-50 -mb-3 flex w-full items-center justify-center pt-5 text-center text-sm">
						{eventDateString}
					</p>
					<div className="p-5">
						<div className="flex flex-col items-center justify-center gap-2 text-center">
							<p className="text-balance text-lg font-semibold">
								{enrollmentState.title}
							</p>
							<p className="text-foreground/80 text-balance text-sm">
								{enrollmentState.subtitle}
							</p>
						</div>
						{renderWaitlistForm()}
					</div>
				</>
			)}
		</>
	)
}
