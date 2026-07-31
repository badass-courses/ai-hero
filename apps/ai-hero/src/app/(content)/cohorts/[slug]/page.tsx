import type { ParsedUrlQuery } from 'querystring'
import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CldImage } from '@/components/cld-image'
import { CheckoutSurveyBuyButton } from '@/components/commerce/checkout-survey-buy-button'
import { Contributor } from '@/components/contributor'
import LayoutClient from '@/components/layout-client'
import { DiscountCountdown } from '@/components/mdx/mdx-components'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import { DiscountDeadline } from '@/components/pricing/discount-deadline'
import { HasPurchased } from '@/components/pricing/has-purchased'
import { PricingInline } from '@/components/pricing/pricing-inline'
import { db } from '@/db'
import { products, users } from '@/db/schema'
import { env } from '@/env.mjs'
import type { CampaignLanding } from '@/lib/campaign-landings'
import { CohortPageProps, type Cohort } from '@/lib/cohort'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { getCachedCohort, loadCohortPageData } from '@/lib/cohorts-query'
import { isOnCohortWaitlist } from '@/lib/cta-gating'
import { getSubscriberForGating } from '@/lib/subscriber-gate'
import {
	CourseStructuredData,
	ProductStructuredData,
} from '@/lib/structured-data'
import type { Workshop } from '@/lib/workshops'
import { getProviders } from '@/server/auth'
import { compileMDX } from '@/utils/compile-mdx'
import { formatDiscount } from '@/utils/discount-formatter'
import { formatInTimeZone } from 'date-fns-tz'
import { eq } from 'drizzle-orm'
import { CheckCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { Certificate } from '../../_components/cohort-certificate-container'
import { EditWorkshopButton } from '../../workshops/_components/edit-workshop-button'
import { CohortContents } from './_components/cohort-contents'
import { CohortFactStrip } from './_components/cohort-fact-strip'
import { CohortIncludes } from './_components/cohort-includes'
import { CohortPricingWidgetContainer } from './_components/cohort-pricing-widget-container'
import { CohortSidebar } from './_components/cohort-sidebar'
import ConnectDiscordButton from './_components/connect-discord-button'

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

	return {
		title: cohort.fields.title,
		description: cohort.fields.description,
		alternates: {
			canonical: `/cohorts/${cohort.fields.slug}`,
		},
		openGraph: {
			images: [
				{
					url:
						cohort?.fields?.image ||
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

	// Already on this cohort's waitlist. Resolved here, on the server, because
	// the sidebar's closed-enrollment state IS the waitlist form: someone who
	// joined last month and came back to check on the dates was being asked to
	// join again, with no sign the site had heard them the first time.
	const gatingSubscriber = await getSubscriberForGating()
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
		allowPurchase === 'true' ||
		cohortProps?.product?.fields.state === 'published'

	// Controls whether inline <Enroll> buttons can actually purchase
	// Enrollment dates must be satisfied even when product is published
	const openEnrollment = cohortProps?.product?.fields?.openEnrollment
	const closeEnrollment = cohortProps?.product?.fields?.closeEnrollment
	const openEnrollmentDate = openEnrollment
		? new Date(openEnrollment as string)
		: null
	const nowInPT = new Date(
		formatInTimeZone(new Date(), PT, "yyyy-MM-dd'T'HH:mm:ssXXX"),
	)
	const isWithinEnrollmentWindow = openEnrollmentDate
		? openEnrollmentDate < nowInPT &&
			(closeEnrollment ? new Date(closeEnrollment as string) > nowInPT : true)
		: true // no dates set = no restriction

	const CAN_ENROLL =
		allowPurchase === 'true' ||
		(cohortProps?.product?.fields.state === 'published' &&
			isWithinEnrollmentWindow)

	const enrollmentOpenDateString = openEnrollmentDate
		? formatInTimeZone(openEnrollmentDate, PT, "MMM d, yyyy 'at' h:mm a zzz")
		: null

	// "Trained" in the fact strip: a live count across every cohort to date,
	// dropped rather than guessed when it is too small to quote — including
	// when the count itself fails, which must never take the sales page down
	// with it (`.catch(() => 0)`, as on the landing page and /courses).
	// Fetched alongside the product map because neither depends on the other,
	// and serialising them only adds latency to the server render.
	const [alumniCount, allProducts] = await Promise.all([
		getCachedCohortAlumniCount().catch(() => 0),
		db.query.products.findMany({
			where: eq(products.status, 1),
		}),
	])
	const alumniLabel = formatAlumniCount(alumniCount)

	const providers = getProviders()
	const discordProvider = providers?.discord
	const userWithAccountsLoader = session?.user
		? db.query.users.findFirst({
				where: eq(users.id, session.user.id),
				with: {
					accounts: true,
				},
			})
		: null

	// Get product slug to ID map for HasPurchased component
	const productMap = new Map(allProducts.map((p) => [p.fields?.slug, p.id]))
	// Use post-purchase body copy for purchasers when available,
	// otherwise fall back to the standard sales body
	const mdxSource =
		hasCohortAccess && cohort.fields.postPurchaseBody
			? cohort.fields.postPurchaseBody
			: cohort.fields.body || ''

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

	const { content } = await compileMDX(
		mdxSource,
		{
			h1: ({ children }: { children: React.ReactNode }) => (
				<h2 className="mb-5 text-3xl font-semibold tracking-tight">
					{children}
				</h2>
			),
			Enroll: ({ children = 'Enroll Now' }) => {
				if (!cohortProps.product || hasCohortAccess) return null

				if (!CAN_ENROLL) {
					return (
						<div className="mt-5 flex flex-col items-start gap-2">
							<button
								disabled
								className="bg-primary/50 text-primary-foreground relative h-auto w-full cursor-not-allowed rounded-lg px-8 py-3 font-semibold opacity-75 sm:h-14 sm:w-auto md:px-16"
							>
								<span className="relative z-10">{children}</span>
							</button>
							{enrollmentOpenDateString && (
								<p className="text-muted-foreground text-sm">
									Enrollment opens {enrollmentOpenDateString}
								</p>
							)}
						</div>
					)
				}

				return (
					<Pricing.Root
						{...cohortProps}
						product={cohortProps.product}
						country={cohortProps.country}
						options={{
							withTitle: false,
							withImage: false,
						}}
						userId={cohortProps?.userId}
						pricingDataLoader={cohortProps.pricingDataLoader}
						className="mt-5 items-start justify-start"
					>
						<Pricing.Product>
							<CheckoutSurveyBuyButton className="bg-primary text-primary-foreground hover:bg-primary/90 relative h-auto w-full cursor-pointer rounded-lg px-8 font-semibold sm:h-14 sm:w-auto md:px-16">
								<span className="relative z-10">{children}</span>
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
					pricingDataLoader={cohortProps.pricingDataLoader}
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
					purchases={cohortProps.purchases || []}
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
				<CohortMetadata
					cohort={displayCohort}
					product={cohortProps.product}
					quantityAvailable={cohortProps.quantityAvailable}
				/>
				<EditWorkshopButton
					className=""
					moduleType="cohort"
					moduleSlug={cohort.fields?.slug || cohort.id}
					product={product}
				/>

				{hasCohortAccess ? (
					<div className="px-4.5 flex w-full flex-col items-center justify-between gap-3 border-b py-2 text-left sm:flex-row">
						<div className="flex items-center text-sm">
							<CheckCircle className="mr-2 size-4 text-emerald-600 dark:text-emerald-300" />{' '}
							You have purchased a ticket to this cohort.
						</div>
						<React.Suspense fallback={null}>
							<ConnectDiscordButton
								userWithAccountsLoader={userWithAccountsLoader}
								discordProvider={discordProvider}
								userId={session?.user?.id}
							/>
						</React.Suspense>
					</div>
				) : null}

				<div className="flex flex-col lg:flex-row">
					<div className="min-w-0 flex-1">
						{/* `lg:pt-[52px]` is the spec's `--ah-section`; at `lg:pt-8` the
						    title sat almost against the nav on desktop. */}
						<header className="from-card to-background flex w-full flex-col items-center justify-between bg-gradient-to-b pt-6 md:gap-10 lg:flex-row lg:pt-[52px]">
							{fields?.image && (
								<CldImage
									className="flex w-full lg:hidden"
									width={383}
									height={204}
									src={fields?.image}
									alt={fields?.title}
								/>
							)}
							<div className="mt-5 flex w-full flex-col items-center px-5 text-center lg:mt-0 lg:items-start lg:pl-10 lg:text-left">
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
								<h1 className="text-balance text-4xl font-bold sm:text-5xl lg:text-6xl">
									{campaignVariant?.headline ?? fields.title}
								</h1>
								{(campaignVariant?.subhead || fields.description) && (
									<h2 className="text-primary mt-5 text-balance text-lg font-normal sm:text-xl lg:text-2xl">
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
						    70ch on the padded element would be 70ch minus the gutter. */}
						<div className="px-5 pt-10 sm:px-8 lg:px-10">
							<article
								className={`prose dark:prose-invert sm:prose-lg lg:prose-lg ${PROSE_MEASURE}`}
							>
								{content}
							</article>
						</div>

						<CohortContents
							className="py-8"
							variant="full"
							workshops={displayWorkshops as Workshop[]}
							workshopProgressMap={workshopProgressMap}
							timezone={PT}
						/>
					</div>
					<CohortSidebar cohort={displayCohort}>
						{fields?.image && (
							<CldImage
								className="hidden w-full lg:flex"
								width={383}
								height={204}
								src={fields?.image}
								alt={fields?.title}
							/>
						)}
						{/* <CohortDetails cohort={displayCohort} /> */}
						{hasCohortAccess ? (
							<div>
								<CohortContents
									variant="rail"
									workshops={displayWorkshops as Workshop[]}
									workshopProgressMap={workshopProgressMap}
									timezone={PT}
								/>
								<Certificate
									isCompleted={hasCompletedCohort}
									resourceSlugOrId={cohort.fields?.slug}
								/>
							</div>
						) : ALLOW_PURCHASE ? (
							<CohortPricingWidgetContainer
								{...cohortProps}
								searchParams={searchParams}
								enrollmentOpenDateString={enrollmentOpenDateString}
								isOnWaitlist={isOnWaitlist}
								knownIdentity={hasKnownWaitlistIdentity}
							/>
						) : null}
						{/* Last in the rail in every state: waitlist, pricing and
						    purchased all answer the same "what do I get" question. */}
						<CohortIncludes workshopCount={displayWorkshops.length} />
					</CohortSidebar>
				</div>
				{/* <CohortSidebarMobile cohort={displayCohort} /> */}
			</main>
		</LayoutClient>
	)
}

const CohortMetadata: React.FC<{
	cohort: Cohort
	product?: CohortPageProps['product']
	quantityAvailable: number
}> = ({ cohort, product, quantityAvailable }) => {
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
