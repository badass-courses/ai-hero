'use client'

import type { ParsedUrlQuery } from 'querystring'
import * as React from 'react'
import { useSession } from 'next-auth/react'
import { PricingWidget } from '@/app/(content)/workshops/_components/pricing-widget'
import { RegionalPricingNote } from '@/app/(content)/workshops/_components/regional-pricing-note'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'
import { CldImage } from '@/components/cld-image'
import { CheckoutSurveyBuyButton } from '@/components/commerce/checkout-survey-buy-button'
import { ConversionIntentButton } from '@/components/cta/conversion-intent-button'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { TYPE } from '@/components/landing/type'
import { env } from '@/env.mjs'
import type { CohortPageProps } from '@/lib/cohort'
import { track } from '@/utils/analytics'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { formatInTimeZone } from 'date-fns-tz'
import { CheckCircle } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import {
	CohortIncludes,
	cohortLessonFeatures,
	type CohortWorkshopRef,
} from './cohort-includes'
import { CohortTeamLink } from './cohort-team-link'

export const CohortPricingWidgetContainer: React.FC<
	CohortPageProps & {
		className?: string
		searchParams?: ParsedUrlQuery
		enrollmentOpenDateString?: string | null
		/** Fresh server-verified gift access; never derived from via or client input. */
		giftEnrollmentOpen?: boolean
		/**
		 * Resolved on the server from the subscriber's `waitlist_<product>` field.
		 * Passed in rather than read here so the sidebar is correct in the first
		 * paint — this widget is above the fold on a page someone re-visits
		 * specifically to check on a cohort they are waiting for.
		 */
		isOnWaitlist: boolean
		/** Cookie- or session-resolved identity; known readers get one button. */
		knownIdentity: boolean
		/** The cohort's workshops, for the feature list's count. */
		workshops: CohortWorkshopRef[]
		/** Lessons across those workshops; 0 leaves the row out. */
		lessonCount: number
		/** The cohort's team page, when it has one. */
		teamOptionsHref?: string
	}
> = ({
	className,
	searchParams,
	enrollmentOpenDateString,
	giftEnrollmentOpen = false,
	isOnWaitlist,
	knownIdentity,
	workshops,
	lessonCount,
	teamOptionsHref,
	...props
}) => {
	const { status: sessionStatus } = useSession()
	const [waitlistResult, setWaitlistResult] = React.useState<
		'joined' | 'confirmation-required' | null
	>(null)
	const [requiresIdentityForm, setRequiresIdentityForm] = React.useState(false)
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

	// Everything in the rail below the offer, for the states with no pricing
	// card. The card carries both itself (its own checklist, its own "Buy for
	// your team"), so these render only when the card does not.
	const belowOffer = (
		<>
			{teamOptionsHref ? <CohortTeamLink href={teamOptionsHref} /> : null}
			<CohortIncludes
				className="border-t px-5 py-6"
				workshops={workshops}
				lessonCount={lessonCount}
			/>
		</>
	)

	if (!product || product.status !== 1) return belowOffer
	const { openEnrollment, closeEnrollment } = product.fields || {}
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

	const { dateString: eventDateString, timeString: eventTimeString } =
		formatCohortDateRange(startsAt, endsAt, timezone)

	// Determine the current state and messaging
	const getEnrollmentState = () => {
		if (couponFromCode?.fields?.bypassSoldOut === true) {
			return { type: 'open' as const }
		}
		if (giftEnrollmentOpen || isOpenEnrollment) {
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

	const renderWaitlistForm = () => {
		if (waitlistResult) {
			return (
				<p className="inline-flex items-center text-center text-lg font-medium">
					<CheckCircle className="text-primary mr-2 size-5" />
					{waitlistResult === 'joined'
						? 'You are on the waitlist'
						: 'Check your inbox to confirm'}
				</p>
			)
		}

		if (!knownIdentity && sessionStatus === 'loading') {
			// The height of the form it stands in for (name, email, button,
			// stacked: 212px). It was one row tall, so when the session resolved
			// the form arrived 164px taller and pushed the rest of the rail down.
			return <div className="bg-muted mt-5 h-[212px] w-full animate-pulse" />
		}

		const intent = {
			kind: 'cohort-waitlist' as const,
			productName: product.name,
		}
		const isKnown =
			(knownIdentity || sessionStatus === 'authenticated') &&
			!requiresIdentityForm

		if (isKnown) {
			return (
				<ConversionIntentButton
					intent={intent}
					surface="cohort-page"
					label="Join Waitlist"
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring relative z-10 mt-5 inline-flex h-12 w-full cursor-pointer items-center justify-center rounded-[9px] px-5 text-base font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
					onSuccess={({ confirmationRequired }) => {
						track('waitlist_joined', {
							product_name: product.name,
							product_id: product.id,
							method: 'one-click',
						})
						setWaitlistResult(
							confirmationRequired ? 'confirmation-required' : 'joined',
						)
					}}
					onNotIdentified={() => setRequiresIdentityForm(true)}
				/>
			)
		}

		return (
			<ConversionIntentForm
				intent={intent}
				surface="cohort-page"
				actionLabel="Join Waitlist"
				className="w-full relative z-10 mt-5 flex flex-col items-center justify-center gap-2 [&_button]:mt-1 [&_button]:h-12 [&_button]:w-full [&_button]:text-base [&_input]:h-12 [&_input]:text-lg"
				successMessage={
					<p className="inline-flex items-center text-center text-lg font-medium">
						<CheckCircle className="text-primary mr-2 size-5" /> You are on the
						waitlist
					</p>
				}
				onSuccess={(subscriber) => {
					if (!subscriber) return
					track('waitlist_joined', {
						product_name: product.name,
						product_id: product.id,
						method: 'form',
					})
					setWaitlistResult(
						subscriber.state === 'active' ? 'joined' : 'confirmation-required',
					)
				}}
			/>
		)
	}

	return (
		<>
			{enrollmentState.type === 'open' || allowPurchase ? (
				// The workshop page's card, as it is there: it fills the column
				// edge to edge and pads itself, so nothing here insets it.
				<div className={className}>
					{renderImage()}
					<PricingWidget
						workshops={workshops}
						prependFeatures={cohortLessonFeatures(lessonCount)}
						product={product}
						quantityAvailable={quantityAvailable}
						commerceProps={commerceProps}
						pricingDataLoader={pricingDataLoader}
						nameMeta={
							eventDateString ? (
								<span className={cn(TYPE.metaMark, 'mt-1.5')}>
									{eventDateString}
								</span>
							) : null
						}
						// "/boss/<slug>" falls back to the generic letter for a cohort
						// without one of its own, so the link is always safe to offer.
						teamLetterHref={`/boss/${cohort.fields.slug}`}
						teamOptionsHref={teamOptionsHref}
						buyButton={
							// Still the survey button: it asks what brought the buyer here
							// before Stripe, and it owns the purchase gate ("Sign in to
							// buy", the caption for a returning student under it, the
							// regional-ticket path). Only its dress changes, to the house
							// CTA.
							<div className="mt-4 flex w-full flex-col">
								<CheckoutSurveyBuyButton
									className={cn(WORKSHOP_CTA_BUTTON, 'w-full')}
								>
									Enroll
								</CheckoutSurveyBuyButton>
								{/* Renders into the phone's bottom bar, not here: it needs
								    this card's quote, and the bar has none of its own. */}
								<RegionalPricingNote targetId="buy" />
							</div>
						}
						pricingWidgetOptions={{
							cancelUrl: `${env.NEXT_PUBLIC_URL}/cohorts/${cohort.fields.slug}`,
							isCohort: true,
							isLiveEvent: true,
							withImage: false,
							// The cover above the card already carries the title.
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
					{/* Someone already on the waitlist gets a confirmation, not the ask.

					    Every subtitle in `getEnrollmentState` ends in "join the
					    waitlist", and under it sat the form to do exactly that — which
					    is the right sidebar for a first-time visitor and the wrong one
					    for the person most likely to be looking at it, someone who
					    joined weeks ago and came back to see whether the dates are set.

					    Dropping the ask alone left them the date and no sign the page
					    had heard them. So the rail says what the inline block in the
					    body says: you are on the waitlist, and under it the fact they
					    came for — closed, or opening on a date. */}
					<div className="p-5">
						<div className="flex flex-col items-center justify-center gap-2 text-center">
							{isOnWaitlist ? (
								<>
									<p className="flex items-center gap-2 text-lg font-semibold">
										<CheckCircle
											className="text-primary size-5 shrink-0"
											aria-hidden="true"
										/>
										You are on the waitlist
									</p>
									<p className="text-muted-foreground text-balance text-sm">
										{enrollmentState.title}
									</p>
								</>
							) : (
								<>
									<p className="text-balance text-lg font-semibold">
										{enrollmentState.title}
									</p>
									<p className="text-foreground/80 text-balance text-sm">
										{enrollmentState.subtitle}
									</p>
								</>
							)}
						</div>
						{isOnWaitlist ? null : renderWaitlistForm()}
					</div>
					{belowOffer}
				</>
			)}
		</>
	)
}
