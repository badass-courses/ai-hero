'use client'

import * as React from 'react'
import type { ProductPricingFeature } from '@/components/commerce/product-pricing-features'
import { ConversionIntentButton } from '@/components/cta/conversion-intent-button'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import { env } from '@/env.mjs'
import { track } from '@/utils/analytics'
import { formatInTimeZone } from 'date-fns-tz'
import { CheckCircle } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { PricingWidget } from './pricing-widget'
import type { WorkshopPageProps } from './workshop-page-props'

/** Polling interval for seat availability (5 seconds) */
const AVAILABILITY_POLL_INTERVAL = 5000

export const WorkshopPricingWidgetContainer: React.FC<
	WorkshopPageProps & {
		className?: string
		searchParams?: { [key: string]: string | string[] | undefined }
		workshops?: {
			title: string
			slug: string
		}[]
		prependFeatures?: ProductPricingFeature[]
		pricingWidgetOptions?: any
		pathname?: string
	}
> = ({
	className,
	searchParams,
	workshops,
	prependFeatures,
	pricingWidgetOptions,
	pathname,
	...props
}) => {
	const {
		product,
		quantityAvailable: initialQuantityAvailable,
		pricingDataLoader,
		hasPurchasedCurrentProduct,
		...commerceProps
	} = props
	const couponFromCode = commerceProps?.couponFromCode
	const { allowPurchase } = searchParams || {}
	// A signed-in viewer must not be asked to type the address they signed in
	// with — the waitlist becomes one button, and the server action resolves
	// their identity itself. `onNotIdentified` drops back to the form when the
	// session turns out stale on the server.
	const { status: sessionStatus } = useSession()
	const [waitlistResult, setWaitlistResult] = React.useState<
		'joined' | 'confirmation-required' | null
	>(null)
	const [requiresIdentityForm, setRequiresIdentityForm] = React.useState(false)

	// Track current availability with polling for live events
	const [currentQuantityAvailable, setCurrentQuantityAvailable] =
		React.useState(initialQuantityAvailable)

	const isLiveEvent = product?.type === 'live'
	const hasLimitedSeats = initialQuantityAvailable !== -1

	// Poll for seat availability on products with limited seats
	React.useEffect(() => {
		if (!hasLimitedSeats || !product?.id) {
			return
		}

		const checkAvailability = async () => {
			try {
				const response = await fetch(`/api/products/${product.id}/availability`)
				if (response.ok) {
					const data = await response.json()
					if (typeof data.quantityAvailable === 'number') {
						setCurrentQuantityAvailable(data.quantityAvailable)
					}
				}
			} catch (error) {
				// Silently fail - we'll try again on next interval
			}
		}

		// Initial check after mount
		const initialTimeout = setTimeout(checkAvailability, 1000)

		// Set up polling interval
		const intervalId = setInterval(
			checkAvailability,
			AVAILABILITY_POLL_INTERVAL,
		)

		return () => {
			clearTimeout(initialTimeout)
			clearInterval(intervalId)
		}
	}, [hasLimitedSeats, product?.id])

	// Get current time in PT for comparison
	const tz = 'America/Los_Angeles'
	const nowInPT = new Date(
		formatInTimeZone(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
	)

	// Check enrollment status from product fields
	const { openEnrollment, closeEnrollment } = product?.fields || {}

	const isOpenEnrollment = openEnrollment
		? new Date(openEnrollment) < nowInPT &&
			(closeEnrollment ? new Date(closeEnrollment) > nowInPT : true)
		: true // Default to open if no enrollment dates set

	// Check if enrollment hasn't opened yet
	const enrollmentNotOpenYet = openEnrollment
		? new Date(openEnrollment) > nowInPT
		: false

	// Check if sold out (any product with limited seats) - uses polled value
	const isSoldOut =
		hasLimitedSeats &&
		currentQuantityAvailable <= 0 &&
		!couponFromCode?.fields?.bypassSoldOut

	// Determine enrollment state. The three non-open states share the band-card
	// language of the pre-launch waitlist (`workshop-interest-cta.tsx`): a
	// status badge, a short ask, one sentence of why — because to the reader
	// they are the same situation (can't buy now, leave your address) arrived
	// at for different reasons.
	const getEnrollmentState = () => {
		// Bypass sold out if coupon allows
		if (couponFromCode?.fields?.bypassSoldOut === true) {
			return { type: 'open' as const }
		}

		// Check sold out first
		if (isSoldOut) {
			return {
				type: 'sold-out' as const,
				badge: 'Sold out',
				title: 'Every seat is taken',
				subtitle:
					'Join the waitlist and we’ll email you if a spot opens up.',
			}
		}

		// Check enrollment dates
		if (isOpenEnrollment) {
			return { type: 'open' as const }
		}

		if (enrollmentNotOpenYet) {
			const enrollmentOpenDateString = openEnrollment
				? formatInTimeZone(
						new Date(openEnrollment),
						tz,
						"MMM dd, yyyy 'at' h:mm a zzz",
					)
				: null

			return {
				type: 'not-open' as const,
				badge: openEnrollment
					? `Opens ${formatInTimeZone(new Date(openEnrollment), tz, 'MMM d')}`
					: 'Opens soon',
				title: 'Enrollment opens soon',
				subtitle: enrollmentOpenDateString
					? `Doors open ${enrollmentOpenDateString}. Join the waitlist and the email arrives the moment they do.`
					: 'Join the waitlist and the email arrives the moment doors open.',
			}
		}

		// Enrollment is closed
		return {
			type: 'closed' as const,
			badge: 'Enrollment closed',
			title: 'Missed this round?',
			subtitle:
				'Join the waitlist and we’ll let you know when enrollment opens again.',
		}
	}

	const enrollmentState = getEnrollmentState()

	// The card's control, in the interest-cta's own vocabulary: 44px controls at
	// 9px radius, gold submit, and a skeleton that holds the footprint while the
	// session resolves.
	const renderWaitlistForm = () => {
		if (!product) return null

		if (waitlistResult) {
			return (
				<p
					className={cn(
						TYPE.meta,
						'text-primary flex items-start gap-2 text-balance',
					)}
				>
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
					{waitlistResult === 'joined'
						? 'You’re on the waitlist. We’ll email you the moment a seat opens.'
						: 'Check your inbox to confirm your spot on the waitlist.'}
				</p>
			)
		}

		// Hold the control's footprint until the session answers, so a signed-in
		// visitor never sees the email form flash in before the one-click button.
		if (sessionStatus === 'loading') {
			return (
				<div className="bg-muted h-11 w-full animate-pulse rounded-[9px]" />
			)
		}

		// The intent carries the Kit field, form, source and tag — the same
		// `waitlist_<product>` contract the cohort widget writes, so gating
		// recognises either entry point.
		const intent = {
			kind: 'cohort-waitlist' as const,
			productName: product.name,
		}

		if (
			sessionStatus === 'authenticated' &&
			!requiresIdentityForm
		) {
			return (
				<ConversionIntentButton
					intent={intent}
					surface="workshop-page"
					label="Join the waitlist"
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring focus-visible:ring-offset-background relative z-10 inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-[9px] px-[18px] text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
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
			<div>
				<ConversionIntentForm
					intent={intent}
					surface="workshop-page"
					actionLabel="Join the waitlist"
					className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:shadow-none [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-2.5 [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-subtle)] [&_label]:sr-only"
					successMessage={
						<p
							className={cn(
								TYPE.meta,
								'text-primary flex items-start gap-2 text-balance',
							)}
						>
							<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> You’re on the
							waitlist.
						</p>
					}
					onSuccess={(subscriber) => {
						if (subscriber && product) {
							// No email in the payload — track() forwards params to a
							// third-party analytics store, and an address is PII.
							track('waitlist_joined', {
								product_name: product.name,
								product_id: product.id,
								method: 'form',
							})
						}
					}}
				/>
				<p className={cn(TYPE.metaSm, 'mt-3 text-[color:var(--ah-fg-subtle)]')}>
					No spam. Unsubscribe anytime.
				</p>
			</div>
		)
	}

	if (!product || product.status !== 1) {
		return null
	}

	// Don't show if product is not published (unless bypass is set)
	if (product.fields.state !== 'published' && !allowPurchase) {
		return null
	}

	const cancelUrl = pathname ? `${env.NEXT_PUBLIC_URL}${pathname}` : ''

	// "/workshops/<slug>" → "/boss/<slug>": the shareable approval letter for
	// this workshop. The route falls back to the generic letter for slugs
	// without one of their own, so the link is always safe to offer.
	const workshopSlug = pathname?.match(/^\/workshops\/([^/]+)$/)?.[1]
	const teamLetterHref = workshopSlug ? `/boss/${workshopSlug}` : undefined

	return (
		<>
			{enrollmentState.type === 'open' || allowPurchase ? (
				// The card fills its column edge-to-edge and pads itself — see the
				// sidebar shell's note on why the shell carries no padding.
				<div className={cn('h-full', className)}>
					<PricingWidget
						workshops={workshops}
						product={product}
						quantityAvailable={currentQuantityAvailable}
						commerceProps={{ ...commerceProps, products: [product] }}
						pricingDataLoader={pricingDataLoader}
						hasPurchasedCurrentProduct={hasPurchasedCurrentProduct}
						prependFeatures={prependFeatures}
						teamLetterHref={teamLetterHref}
						pricingWidgetOptions={{
							withImage: false,
							withGuaranteeBadge: true,
							isLiveEvent: product.type === 'live',
							isCohort: product.type === 'cohort',
							isPPPEnabled: true,
							cancelUrl,
							...pricingWidgetOptions,
						}}
					/>
				</div>
			) : (
				// Sold out / not-open-yet / closed: the waitlist band card on the
				// hatched ground — the same object the pre-launch interest card is,
				// because it is the same ask. The ground runs the column's full
				// height for the same reason it does there.
				<div
					className={cn(
						'bg-muted bg-stripes-muted flex h-full flex-col p-5 sm:p-6',
						className,
					)}
				>
					<div className="border-border flex flex-col gap-4 rounded-lg border bg-[color:var(--ah-band)] px-5 py-6 sm:px-6">
						<div className="flex flex-col gap-1.5">
							<p>
								<span
									className={cn(TYPE.badge, BADGE_NEUTRAL, 'inline-block')}
								>
									{enrollmentState.badge}
								</span>
							</p>
							<h3 className={cn(TYPE.panelTitle, 'text-balance font-sans')}>
								{enrollmentState.title}
							</h3>
							<p
								className={cn(
									TYPE.metaProse,
									'text-pretty text-[color:var(--ah-fg-muted)]',
								)}
							>
								{enrollmentState.subtitle}
							</p>
						</div>
						{renderWaitlistForm()}
					</div>
				</div>
			)}
		</>
	)
}
