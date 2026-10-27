import type { ParsedUrlQuery } from 'querystring'
import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import { CldImage } from '@/components/cld-image'
import { C5PastCohortCallout } from '@/components/c5-past-cohort-callout'
import { WaitlistForm } from '@/components/cohort-waitlist-form'
import { CheckoutSurveyBuyButton } from '@/components/commerce/checkout-survey-buy-button'
import { Contributor } from '@/components/contributor'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { formatOpensIn } from '@/lib/cohort-opening'
import { giftSharePresentation, giftShareTitle } from '@/lib/c5-pricing/gift-share'
import { signedGiftFact, giftEnrollmentAccess } from '@/lib/c5-pricing/gift-server'
import { GiftShareAttribution } from '@/components/gift-share-attribution'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/products'
import { DiscountCountdown } from '@/components/mdx/mdx-components'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import { DiscountDeadline } from '@/components/pricing/discount-deadline'
import { HasPurchased } from '@/components/pricing/has-purchased'
import { PricingInline } from '@/components/pricing/pricing-inline'
import { env } from '@/env.mjs'
import type { CampaignLanding } from '@/lib/campaign-landings'
import { CohortPageProps, type Cohort } from '@/lib/cohort'
import { toClientCohortPageProps } from '@/lib/cohort-client-shape'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { getCachedCohort, loadCohortPageData } from '@/lib/cohorts-query'
import { isOnCohortWaitlist } from '@/lib/cta-gating'
import { getActiveProductSlugMap } from '@/lib/product-slug-map'
import { startEarly } from '@/lib/start-early'
import { getSubscriberForGating } from '@/lib/subscriber-gate'
import {
	CourseStructuredData,
	ProductStructuredData,
} from '@/lib/structured-data'
import type { Workshop } from '@/lib/workshops'
import { compileMDX } from '@/utils/compile-mdx'
import { formatDiscount } from '@/utils/discount-formatter'
import { CheckCircle } from 'lucide-react'
import { Markdown as ReactMarkdown } from '@/components/markdown'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { Certificate } from '../../_components/cohort-certificate-container'
import { EditWorkshopButton } from '../../workshops/_components/edit-workshop-button'
import {
	cohortCallsToAction,
	cohortEnrollmentPhase,
} from './_components/cohort-coming-soon'
import { CohortCertificateProgress } from './_components/cohort-certificate-progress'
import { CohortContents } from './_components/cohort-contents'
import { CohortEnrollPrice } from './_components/cohort-enroll-price'
import { CohortFactStrip } from './_components/cohort-fact-strip'
import { CohortIncludes } from './_components/cohort-includes'
import { CohortPricingWidgetContainer } from './_components/cohort-pricing-widget-container'
import { CohortSidebar } from './_components/cohort-sidebar'
import { CohortTeamLink } from './_components/cohort-team-link'
import { metaDescription } from '@/lib/meta-description'

export async function generateMetadata(
	props: {
		params: Promise<{ slug: string }>
		searchParams: Promise<{ [key: string]: string | string[] | undefined }>
	},
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const cohort = await getCachedCohort(params.slug)

	if (!cohort) {
		return parent as Metadata
	}

	const via = (await props.searchParams).via
	const share = await giftSharePresentation(typeof via === 'string' ? via : undefined).catch(() => null)
	const title = share ? `${giftShareTitle(share.firstName, share.available)}: ${cohort.fields.title}` : cohort.fields.title
	return {
		title,
		description: metaDescription(cohort.fields.description),
		alternates: {
			canonical: `/cohorts/${cohort.fields.slug}`,
		},
		openGraph: {
			title,
			images: [
				{
					url:
						(share && typeof via === 'string' ? `${env.NEXT_PUBLIC_URL}/api/og/gift?via=${encodeURIComponent(via)}` : undefined) || cohort?.fields?.image ||
						`${env.NEXT_PUBLIC_URL}/api/og/default?title=${encodeURIComponent(cohort.fields.title)}`,
					alt: cohort?.fields?.title,
				},
			],
		},
	}
}

type CohortPageViewProps = {
	params: Promise<{ slug: string }>
	searchParams: Promise<ParsedUrlQuery>
	campaignLanding?: CampaignLanding
	/**
	 * MDX that replaces the CMS body for this render. Only
	 * `/preview/cohorts/[slug]/[draft]` passes it, from a file on disk.
	 */
	bodySource?: string
}

/**
 * Default cohort page route entry point.
 *
 * @param props - Cohort page props containing async params and searchParams.
 * @returns The shared cohort page view for the requested cohort slug.
 */
export default async function CohortPage(props: CohortPageViewProps) {
	return CohortPageView(props)
}

/**
 * Renders the shared cohort page, optionally with bounded campaign landing copy.
 *
 * @param props - Cohort page props. `campaignLanding` overrides only approved hero copy slots.
 * @returns The cohort page React tree after loading cohort, commerce, and access data.
 */
export async function CohortPageView(props: CohortPageViewProps) {
	const searchParams = await props.searchParams
	const { allowPurchase } = searchParams
	const params = await props.params

	const cohort = await getCachedCohort(params.slug)

	if (!cohort) {
		notFound()
	}

	// Three reads that need nothing from the loader or from each other: start
	// them now so they run under the loader instead of after it. Each is
	// awaited where it is used, so a failure still fails (or, for the alumni
	// count, still falls back to 0) exactly where it did before.
	const gatingSubscriberRead = startEarly(() => getSubscriberForGating())
	const productMapRead = startEarly(() => getActiveProductSlugMap())
	// "Trained" in the fact strip: a live count across every cohort to date,
	// dropped rather than guessed when it is too small to quote — including
	// when the count itself fails, which must never take the sales page down
	// with it (`.catch(() => 0)`, as on the landing page and /courses).
	const alumniCountRead = getCachedCohortAlumniCount().catch(() => 0)

	const pageData = await loadCohortPageData(params.slug, searchParams)

	const {
		session,
		ability,
		user,
		currentOrganization,
		hasCompletedCohort,
		product,
		pricingDataLoader,
		commerceProps,
		purchaseCount,
		quantityAvailable,
		totalQuantity,
		hasPurchasedCurrentProduct,
		hasAccessToCohort,
		existingPurchase,
		defaultCoupon,
		saleData,
		workshops,
		workshopProgressMap,
	} = pageData

	const share = product?.id === C5_PRODUCT_ID ? await giftSharePresentation(typeof searchParams.via === 'string' ? searchParams.via : undefined).catch(() => null) : null
	const giftFact = product?.id === C5_PRODUCT_ID ? await signedGiftFact() : null
	const giftEnrollmentOpen = await giftEnrollmentAccess(giftFact && 'value' in giftFact ? giftFact.value : null).catch(() => false)
	const giftBanner = !share || share.closed ? null : !share.available ? 'This gift has been used.' : giftFact && 'value' in giftFact && giftFact.value?.codeRef === share.codeRef ? giftShareTitle(share.firstName, true) : giftShareTitle(share.firstName, false)

	// Already on this cohort's waitlist. Resolved here, on the server, because
	// the sidebar's closed-enrollment state IS the waitlist form: someone who
	// joined last month and came back to check on the dates was being asked to
	// join again, with no sign the site had heard them the first time.
	const gatingSubscriber = await gatingSubscriberRead
	const isOnWaitlist = isOnCohortWaitlist(gatingSubscriber, product?.name)
	const hasKnownWaitlistIdentity = Boolean(
		gatingSubscriber?.email_address || session?.user?.email,
	)

	const cohortProps: CohortPageProps = {
		cohort,
		availableBonuses: [],
		purchaseCount,
		quantityAvailable,
		totalQuantity,
		product: product ?? undefined,
		pricingDataLoader,
		hasPurchasedCurrentProduct,
		existingPurchase,
		...commerceProps,
		organizationId: currentOrganization,
	}

	const { fields } = cohort
	const campaignVariant = props.campaignLanding?.variant
	const hasCohortAccess = hasPurchasedCurrentProduct || hasAccessToCohort

	const PT = fields.timezone || 'America/Los_Angeles'

	// Controls whether sidebar shows pricing container (which handles waitlist internally)
	const ALLOW_PURCHASE =
		giftEnrollmentOpen || allowPurchase === 'true' ||
		cohortProps?.product?.fields.state === 'published'

	// One reading of the enrollment window drives every call to action outside
	// the rail (mobile bar, inline <Enroll>, JSON-LD offer), so none of them can
	// say "Enroll" while the rail shows the waitlist.
	const openEnrollment = cohortProps?.product?.fields?.openEnrollment
	const closeEnrollment = cohortProps?.product?.fields?.closeEnrollment
	const openEnrollmentDate = openEnrollment
		? new Date(openEnrollment as string)
		: null
	const enrollmentPhase = giftEnrollmentOpen ? 'open' : cohortEnrollmentPhase({
		now: new Date(),
		openEnrollment: openEnrollment as string | undefined,
		closeEnrollment: closeEnrollment as string | undefined,
	})
	const { isComingSoon, mobileCta, offerInJsonLd, curriculumAnnounced } =
		cohortCallsToAction({
			phase: enrollmentPhase,
			productState: cohortProps?.product?.fields?.state,
			allowPurchase: giftEnrollmentOpen ? 'true' : allowPurchase,
			hasCohortAccess,
			isOnWaitlist,
			hasActiveProduct: cohortProps.product?.status === 1,
			bypassSoldOut:
				cohortProps.couponFromCode?.fields?.bypassSoldOut === true,
		})

	// A rail on the waitlist can also be one whose window has closed, and
	// "opens" must not be said of a date that has passed.
	const enrollmentOpensLater = enrollmentPhase === 'before-open'
	const enrollmentOpenDateString = openEnrollmentDate
		? formatOpensIn(openEnrollmentDate, PT, new Date())
		: null

	const [alumniCount, productMap] = await Promise.all([
		alumniCountRead,
		productMapRead,
	])
	// The lesson total for "Includes" is off for now (Vojta, 2026-10-14): the
	// list leads with the workshop count alone. To bring it back, restore this
	// read (and its two imports) in place of the 0. It costs no data of its
	// own: these are the navigation trees the Contents list reads further down,
	// and the loader shares one read per workshop across the render. If any
	// tree fails the total is dropped, never summed from the ones that
	// answered: an undercount on a sales page is worse than no count.
	//
	// const lessonCount = await Promise.all(
	// 	workshops.map((workshop) =>
	// 		getCachedWorkshopNavigation(workshop.fields.slug),
	// 	),
	// )
	// 	.then((navigations) =>
	// 		navigations.reduce(
	// 			(total, navigation) => total + countTrackedLessons(navigation),
	// 			0,
	// 		),
	// 	)
	// 	.catch(() => 0)
	const lessonCount = 0
	const alumniLabel = formatAlumniCount(alumniCount)

	// Use post-purchase body copy for purchasers when available,
	// otherwise fall back to the standard sales body. A `bodySource` from the
	// preview route stands in for either.
	const mdxSource =
		props.bodySource ??
		(hasCohortAccess && cohort.fields.postPurchaseBody
			? cohort.fields.postPurchaseBody
			: cohort.fields.body || '')

	const displayWorkshops = hasCohortAccess
		? workshops
		: workshops.map((workshop) => ({
				...workshop,
				resources: (workshop.resources ?? []).map((resourceItem) => ({
					...resourceItem,
					resource: {
						id: resourceItem.resource.id,
						type: resourceItem.resource.type,
						fields: {
							title: resourceItem.resource.fields?.title,
							slug: resourceItem.resource.fields?.slug,
							state: resourceItem.resource.fields?.state,
							visibility: resourceItem.resource.fields?.visibility,
						},
						resources: [],
					},
				})),
			}))
	// The rail's feature list counts workshops by what the reader can see
	// listed, and the pricing container needs them as plain data.
	const railWorkshops = displayWorkshops.map((workshop) => ({
		title: workshop.fields.title,
		slug: workshop.fields.slug,
	}))
	// The team page exists only when its body does (it 404s otherwise).
	const teamOptionsHref = fields.forTeamsBody
		? `/cohorts/${fields.slug}/for-teams`
		: undefined
	const displayCohort = hasCohortAccess
		? cohort
		: {
				...cohort,
				resources: (cohort.resources ?? []).map((resourceItem) => ({
					...resourceItem,
					resource: {
						...resourceItem.resource,
						resources: [],
					},
				})),
			}

	// Client components get this, never `cohort`: whatever they receive is
	// serialized into the RSC payload, lesson bodies included.
	const clientCohortProps = toClientCohortPageProps(cohortProps)
	const clientCohort = clientCohortProps.cohort

	// A body that places the curriculum itself replaces the list appended
	// under it, so the workshops appear once. The inline list is only for
	// someone who can buy, so everyone else keeps the appended one. Code and
	// comments are stripped first so a body that only mentions the tag does
	// not hide the real list.
	const showsInlineContentList =
		mobileCta === 'enroll' &&
		/<CohortContentList[\s/>]/.test(
			mdxSource.replace(
				/```[\s\S]*?```|`[^`\n]*`|\{\/\*[\s\S]*?\*\/\}/g,
				'',
			),
		)

	const { content } = await compileMDX(
		mdxSource,
		{
			h1: ({ children }: { children: React.ReactNode }) => (
				<h2 className="mb-5 text-3xl font-semibold tracking-tight">
					{children}
				</h2>
			),
			Enroll: ({ children = 'Enroll Now' }) => {
				if (!clientCohortProps.product || hasCohortAccess) return null

				// While the rail holds the waitlist, an inline button is the same
				// form the rail holds, so the ask can be answered where the reader
				// is: never a dead control, and never an offer the rail does not
				// have. Someone already on the list gets a status and no ask.
				if (mobileCta === 'waitlist' || mobileCta === 'on-waitlist') {
					return (
						<div className="not-prose mx-auto my-8 flex max-w-xl flex-col items-center gap-2.5 text-center">
							{mobileCta === 'waitlist' ? (
								<WaitlistForm
									actionLabel="Join Waitlist"
									productName={clientCohortProps.product.name}
									surface="cohort-page"
									knownIdentity={hasKnownWaitlistIdentity}
								/>
							) : (
								<p className={`${TYPE.subhead} flex items-center gap-2`}>
									<CheckCircle
										className="text-primary size-5 shrink-0"
										aria-hidden="true"
									/>
									You are on the waitlist
								</p>
							)}
							{enrollmentOpensLater && enrollmentOpenDateString ? (
								<p className="text-muted-foreground text-sm">
									Enrollment opens {enrollmentOpenDateString}
								</p>
							) : null}
						</div>
					)
				}

				// No product in the rail to act on.
				if (mobileCta !== 'enroll') return null


				return (
					<Pricing.Root
						{...clientCohortProps}
						product={clientCohortProps.product}
						country={cohortProps.country}
						options={{
							withTitle: false,
							withImage: false,
						}}
						userId={clientCohortProps.userId}
						pricingDataLoader={clientCohortProps.pricingDataLoader}
						// `not-prose`: the button brings a caption of its own, and the
						// article's paragraph margins would push it away from the button.
						className="not-prose my-8 items-center justify-center"
					>
						<Pricing.Product>
							<CheckoutSurveyBuyButton
								className="bg-primary text-primary-foreground hover:bg-primary/90 relative h-auto w-full cursor-pointer rounded-lg px-8 font-semibold sm:h-14 sm:w-auto md:px-16"
								trailing={<CohortEnrollPrice />}
							>
								{/* The body's label ("Reserve Your Spot") and the price do not
								    fit one line on a phone, so the phone says "Enroll" and
								    keeps the price beside it, divider and all. */}
								<span className="relative z-10 sm:hidden">Enroll</span>
								<span className="relative z-10 hidden sm:inline">{children}</span>
								<div
									style={{
										backgroundSize: '200% 100%',
									}}
									className="animate-shine pointer-events-none absolute inset-0 rounded-[inherit] bg-[linear-gradient(120deg,rgba(255,255,255,0)40%,rgba(255,255,255,1)50%,rgba(255,255,255,0)60%)] opacity-10 dark:opacity-20"
								/>
							</CheckoutSurveyBuyButton>
						</Pricing.Product>
					</Pricing.Root>
				)
			},
			// Copy that only makes sense once seats can be bought: a price
			// sentence, the curriculum, a deadline. It follows the rail, like
			// the buttons, so a body can carry its launch section ahead of
			// time and have it appear the moment enrollment opens.
			CanEnroll: ({ children }: { children: React.ReactNode }) =>
				mobileCta === 'enroll' ? <>{children}</> : null,
			// The other side of it: copy that belongs to the waitlist ask ("drop
			// your email in the box below") and would be wrong over a buy button
			// or for someone who already has the cohort.
			WaitlistOnly: ({ children }: { children: React.ReactNode }) =>
				mobileCta === 'waitlist' || mobileCta === 'on-waitlist' ? (
					<>{children}</>
				) : null,
			// The curriculum, placed where the copy calls for it, for someone
			// who can buy it. Everyone else has the list under the body.
			CohortContentList: () =>
				mobileCta === 'enroll' ? (
					<CohortContents
						className="not-prose border-border my-8 overflow-hidden rounded-md border"
						variant="inline"
						workshops={displayWorkshops as Workshop[]}
						workshopProgressMap={workshopProgressMap}
						timezone={PT}
					/>
				) : null,
			HasDiscount: ({
				children,
				fallback,
			}: {
				children: React.ReactNode
				fallback?: React.ReactNode
			}) => {
				// Only show discount if there's an active default coupon (site-wide sale)
				const hasDefaultCoupon = saleData || defaultCoupon
				return hasDefaultCoupon ? (
					<>{children}</>
				) : fallback ? (
					<>{fallback}</>
				) : null
			},
			DiscountCountdown: ({ children }) => {
				return defaultCoupon?.expires ? (
					<DiscountCountdown date={new Date(defaultCoupon?.expires)} />
				) : null
			},
			PricingInline: ({ type }: { type: 'original' | 'discounted' }) => (
				<PricingInline
					type={type}
					pricingDataLoader={clientCohortProps.pricingDataLoader}
				/>
			),
			DiscountDeadline: ({ format }: { format?: 'short' | 'long' }) => (
				<DiscountDeadline
					format={format}
					expires={defaultCoupon?.expires ?? null}
				/>
			),
			HasPurchased: ({
				productSlug,
				productId,
				children,
			}: {
				productSlug?: string
				productId?: string
				children: React.ReactNode
			}) => (
				<HasPurchased
					productSlug={productSlug}
					productId={productId}
					purchases={clientCohortProps.purchases || []}
					productMap={productMap}
				>
					{children}
				</HasPurchased>
			),
		},
		{
			scope: {
				...(saleData
					? { ...saleData }
					: defaultCoupon
						? {
								percentOff: parseFloat(
									(Number(defaultCoupon.percentageDiscount) * 100).toFixed(1),
								),
								discountFormatted: formatDiscount(defaultCoupon),
								discountType:
									defaultCoupon.amountDiscount &&
									defaultCoupon.amountDiscount > 0
										? 'fixed'
										: 'percentage',
								discountValue:
									defaultCoupon.amountDiscount &&
									defaultCoupon.amountDiscount > 0
										? defaultCoupon.amountDiscount / 100
										: parseFloat(
												(
													Number(defaultCoupon.percentageDiscount) * 100
												).toFixed(1),
											),
							}
						: {
								percentOff: null,
								discountFormatted: null,
								discountType: null,
								discountValue: null,
							}),
			},
		},
	)

	return (
		<LayoutClient withContainer>
			<main className="relative">
				<C5PastCohortCallout slug={fields.slug ?? cohort.id} />
				{share && typeof searchParams.via === 'string' ? <GiftShareAttribution slug={searchParams.via} /> : null}
				{giftBanner ? <section className="border-border bg-muted text-foreground border-b"><p className={`${TYPE.meta} px-[18px] py-4 sm:px-11`}>{giftBanner}</p></section> : null}
				<React.Suspense fallback={null}>
					<ResolvedCohortMetadata
						cohort={displayCohort}
						product={offerInJsonLd ? cohortProps.product : undefined}
						pricingDataLoader={pricingDataLoader}
					/>
				</React.Suspense>
				<EditWorkshopButton
					className=""
					moduleType="cohort"
					moduleSlug={cohort.fields?.slug || cohort.id}
					product={clientCohortProps.product}
				/>

				{hasCohortAccess ? (
					<div className="px-4.5 flex w-full flex-col items-center justify-between gap-3 border-b py-2 text-left sm:flex-row">
						<div className="flex items-center text-sm">
							<CheckCircle className="mr-2 size-4 text-emerald-600 dark:text-emerald-300" />{' '}
							You have purchased a ticket to this cohort.
						</div>
					</div>
				) : null}

				<div className="flex flex-col lg:flex-row">
					<div className="min-w-0 flex-1">
						{/* `lg:pt-[52px]` is the spec's `--ah-section`; at `lg:pt-8` the
						    title sat almost against the nav on desktop. Below `lg` the
						    cover leads the header and sits flush under the nav, so the
						    top padding is only for a cohort with no cover to lead it. */}
						<header
							className={`from-card to-background flex w-full flex-col items-center justify-between bg-gradient-to-b md:gap-10 lg:flex-row lg:pt-[52px] ${fields?.image ? '' : 'pt-6'}`}
						>
							{fields?.image && (
								<CldImage
									className="flex w-full lg:hidden"
									width={383}
									height={204}
									src={fields?.image}
									alt={fields?.title}
								/>
							)}
							<div className="mt-5 flex w-full flex-col items-center px-5 text-center lg:mt-0 lg:items-start lg:px-10 lg:text-left">
								<div className="text-foreground/80 mb-2 flex flex-wrap items-center justify-center gap-2 text-base sm:justify-start">
									<span className="text-xs font-medium uppercase tracking-wider">
										{campaignVariant?.eyebrow ?? 'Cohort-based Course'}
									</span>
									{/* <span className="hidden opacity-50 sm:inline-block">・</span>
							{eventDateString && <p>{eventDateString}</p>}
							{eventTimeString && (
								<>
									<span className="opacity-50">・</span>
									<p>{eventTimeString}</p>
								</>
							)} */}
								</div>
								{/* The headline is the offer, so it takes the single-offer
								    landing step, tracking included. */}
								<h1 className={`${TYPE.displayLanding} text-balance`}>
									{campaignVariant?.headline ?? fields.title}
								</h1>
								{(campaignVariant?.subhead || fields.description) && (
									<h2 className="text-primary mt-5 text-balance text-lg font-normal tracking-[-0.018em] sm:text-xl lg:text-2xl lg:tracking-[-0.02em]">
										<ReactMarkdown
											components={{
												p: ({ children }) => <>{children}</>,
											}}
										>
											{campaignVariant?.subhead ?? fields.description ?? ''}
										</ReactMarkdown>
									</h2>
								)}
								{campaignVariant && (
									<section className="border-border bg-background/70 mt-8 w-full max-w-3xl rounded-lg border p-5 text-left shadow-sm">
										<h2 className="text-lg font-semibold leading-tight tracking-tight">
											This is for you if
										</h2>
										<ul className="mt-3 space-y-2 text-sm sm:text-base">
											{campaignVariant.bullets.map((bullet) => (
												<li key={bullet} className="flex gap-2">
													<CheckCircle className="text-primary mt-0.5 size-4 shrink-0" />
													<span>{bullet}</span>
												</li>
											))}
										</ul>
										<div className="border-border mt-5 border-t pt-4">
											<h3 className="font-semibold leading-tight tracking-tight">
												{campaignVariant.proofTitle}
											</h3>
											<p className="text-foreground/80 mt-2 text-sm sm:text-base">
												{campaignVariant.proofBody}
											</p>
										</div>
									</section>
								)}
								<Contributor
									imageSize={60}
									className="mt-8 [&_div]:text-left"
									withBio
								/>
								<CohortFactStrip
									className="mt-8 max-w-3xl"
									cohort={displayCohort}
									alumniLabel={alumniLabel}
								/>
							</div>
						</header>
						{/* Padding sits outside the measure: boxes are border-box, so
						    70ch on the padded element would be 70ch minus the gutter.
						    The bottom padding is for a body that ends the column, with
						    no curriculum under it: the body's last block gives up its
						    own bottom margin, so the space is the same whether that
						    block is a paragraph, a form or a buy button. */}
						<div className="px-5 pt-10 last:pb-10 sm:px-8 lg:px-10">
							<article
								className={`prose dark:prose-invert sm:prose-lg lg:prose-lg [&>:last-child]:mb-0 ${PROSE_MEASURE}`}
							>
								{content}
							</article>
						</div>

						{/* For sale, the body's own inline list stands in for this one.
						    On a launch waitlist there is no curriculum at all. */}
						{!curriculumAnnounced || showsInlineContentList ? null : (
							<CohortContents
								className="py-8"
								variant="full"
								workshops={displayWorkshops as Workshop[]}
								workshopProgressMap={workshopProgressMap}
								timezone={PT}
							/>
						)}
					</div>
					<CohortSidebar
						cohort={clientCohort}
						mobileCta={mobileCta}
					>
						{fields?.image && (
							<CldImage
								className="hidden w-full lg:flex"
								width={383}
								height={204}
								src={fields?.image}
								alt={fields?.title}
							/>
						)}
						<C5PastCohortCallout slug={fields.slug ?? cohort.id} />
						{/* <CohortDetails cohort={displayCohort} /> */}
						{hasCohortAccess ? (
							<div>
								<CohortContents
									variant="rail"
									workshops={displayWorkshops as Workshop[]}
									workshopProgressMap={workshopProgressMap}
									timezone={PT}
								/>
								{/* The count waits on the same progress reads as the rows
								    above; until they land the tile shows without it. */}
								<div className="border-t p-3">
									<React.Suspense
										fallback={
											<Certificate
												isCompleted={hasCompletedCohort}
												resourceSlugOrId={cohort.fields?.slug}
											/>
										}
									>
										<CohortCertificateProgress
											isCompleted={hasCompletedCohort}
											resourceSlugOrId={cohort.fields?.slug}
											workshopProgressMap={workshopProgressMap}
										/>
									</React.Suspense>
								</div>
							</div>
						) : ALLOW_PURCHASE ? (
							<CohortPricingWidgetContainer
								{...clientCohortProps}
								cohort={clientCohort}
								giftEnrollmentOpen={giftEnrollmentOpen}
								searchParams={searchParams}
								enrollmentOpenDateString={enrollmentOpenDateString}
								isOnWaitlist={isOnWaitlist}
								knownIdentity={hasKnownWaitlistIdentity}
								workshops={railWorkshops}
								lessonCount={lessonCount}
								teamOptionsHref={teamOptionsHref}
							/>
						) : isComingSoon && cohortProps.product ? (
							<div className="p-5">
								{isOnWaitlist ? (
									<p className="inline-flex items-center text-center text-lg font-medium">
										<CheckCircle className="text-primary mr-2 size-5" />
										You are on the waitlist
									</p>
								) : (
									<WaitlistForm
										actionLabel="Join Waitlist"
										productName={cohortProps.product.name}
										surface="cohort-page"
										knownIdentity={hasKnownWaitlistIdentity}
									/>
								)}
							</div>
						) : null}
						{/* The pricing container owns everything under the offer when
						    it renders: on sale, its card carries the team button and the
						    feature list itself, and a second copy here would stack two
						    "Includes" in one column. These are for the states it does not
						    cover. The team link is offered in every state but purchased:
						    before seats open it still takes an invoice request. */}
						{!hasCohortAccess && !ALLOW_PURCHASE && teamOptionsHref ? (
							<CohortTeamLink href={teamOptionsHref}>
								{isComingSoon
									? 'Buying for a team?'
									: 'Buying for a team? Seats and invoices'}
							</CohortTeamLink>
						) : null}
						{/* Purchased still answers "what do I get". Coming soon is the
						    exception: nothing is on offer yet. */}
						{isComingSoon || (!hasCohortAccess && ALLOW_PURCHASE) ? null : (
							<CohortIncludes
								className="border-t px-5 py-6"
								workshops={railWorkshops}
								lessonCount={lessonCount}
							/>
						)}
					</CohortSidebar>
				</div>
				{/* <CohortSidebarMobile cohort={displayCohort} /> */}
			</main>
		</LayoutClient>
	)
}

const ResolvedCohortMetadata = async ({
	pricingDataLoader,
	...props
}: {
	cohort: Cohort
	product?: CohortPageProps['product']
	pricingDataLoader: CohortPageProps['pricingDataLoader']
}) => {
	if (!props.product) return <CohortMetadata {...props} />
	// Share the widget's existing promise without blocking the outer page or fetching again.
	let quantityAvailable: number | undefined
	try {
		quantityAvailable = (await pricingDataLoader).quantityAvailable
	} catch {
		// Metadata failure must not fail the page; keep both schemas without an offer.
	}
	return <CohortMetadata {...props} quantityAvailable={quantityAvailable} />
}

const CohortMetadata = ({
	cohort,
	product,
	quantityAvailable,
}: {
	cohort: Cohort
	product?: CohortPageProps['product']
	quantityAvailable?: number
}) => {
	return (
		<>
			<CourseStructuredData
				cohort={cohort}
				product={product}
				quantityAvailable={quantityAvailable}
			/>
			{product ? (
				<ProductStructuredData
					product={product}
					quantityAvailable={quantityAvailable}
					canonicalPath={`/cohorts/${cohort.fields.slug}`}
				/>
			) : null}
		</>
	)
}
