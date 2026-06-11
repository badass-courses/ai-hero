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
import { DiscountDeadline } from '@/components/pricing/discount-deadline'
import { HasPurchased } from '@/components/pricing/has-purchased'
import { PricingInline } from '@/components/pricing/pricing-inline'
import { db } from '@/db'
import { products, users } from '@/db/schema'
import { env } from '@/env.mjs'
import type { CampaignLanding } from '@/lib/campaign-landings'
import { CohortPageProps, type Cohort } from '@/lib/cohort'
import { getCachedCohort, loadCohortPageData } from '@/lib/cohorts-query'
import {
	CourseStructuredData,
	ProductStructuredData,
} from '@/lib/structured-data'
import type { Workshop } from '@/lib/workshops'
import { getCachedWorkshopNavigation } from '@/lib/workshops-query'
import { getProviders } from '@/server/auth'
import { compileMDX } from '@/utils/compile-mdx'
import { formatDiscount } from '@/utils/discount-formatter'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { formatInTimeZone } from 'date-fns-tz'
import { eq } from 'drizzle-orm'
import { CheckCircle, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
	Button,
} from '@coursebuilder/ui'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { Certificate } from '../../_components/cohort-certificate-container'
import { ModuleProgressProvider } from '../../_components/module-progress-provider'
import { EditWorkshopButton } from '../../workshops/_components/edit-workshop-button'
import { WorkshopNavigationProvider } from '../../workshops/_components/workshop-navigation-provider'
import { WorkshopLessonList } from './_components/cohort-list/workshop-lesson-list'
import WorkshopSidebarItem from './_components/cohort-list/workshop-sidebar-item'
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
	const allProducts = await db.query.products.findMany({
		where: eq(products.status, 1),
	})
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
								className="dark:bg-primary/50 relative h-auto w-full cursor-not-allowed rounded-lg bg-blue-600/50 px-8 py-3 font-semibold opacity-75 sm:h-14 sm:w-auto md:px-16"
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
							<CheckoutSurveyBuyButton className="dark:bg-primary dark:hover:bg-primary/90 relative h-auto w-full cursor-pointer rounded-lg bg-blue-600 px-8 font-semibold hover:bg-blue-700 sm:h-14 sm:w-auto md:px-16">
								<span className="relative z-10">{children}</span>
								<div
									style={{
										backgroundSize: '200% 100%',
									}}
									className="animate-shine absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0)40%,rgba(255,255,255,1)50%,rgba(255,255,255,0)60%)] opacity-10 dark:opacity-20"
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
						<header className="from-card to-background flex w-full flex-col items-center justify-between bg-gradient-to-b md:gap-10 lg:flex-row lg:pt-8">
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
							</div>
						</header>
						<article className="prose dark:prose-invert sm:prose-lg lg:prose-lg prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-table:max-w-4xl prose-pre:max-w-4xl **:data-pre:max-w-4xl max-w-none px-5 pt-10 sm:px-8 lg:px-10">
							{content}
						</article>

						<div className="py-8">
							<div className="px-5 sm:px-8 lg:px-10">
								<h2 className="mb-5 text-2xl font-semibold tracking-tight">
									Contents
								</h2>
							</div>
							<div className="flex w-full">
								<ul className="divide-border flex w-full flex-col divide-y border-y">
									{displayWorkshops.map((workshop, index) => {
										const workshopTimezone = workshop.fields.timezone || PT

										const { dateString: workshopDateString } =
											formatCohortDateRange(
												workshop.fields.startsAt,
												null,
												workshopTimezone,
											)

										const moduleProgressLoader =
											workshopProgressMap.get(workshop.fields.slug) ||
											Promise.resolve(null)
										return (
											<li key={workshop.id}>
												<ModuleProgressProvider
													moduleProgressLoader={moduleProgressLoader}
												>
													<Accordion
														type="multiple"
														defaultValue={[`${workshop.id}-body`]}
													>
														<AccordionItem
															value={`${workshop.id}-body`}
															className="data-[state=open]:bg-card/50 border-none transition-colors ease-out"
														>
															<AccordionTrigger className="hover:bg-card text-foreground group relative flex w-full min-w-0 cursor-pointer items-start rounded-none py-3 pl-4 pr-4 text-left transition-colors duration-150 ease-out hover:no-underline [&>svg]:hidden">
																<div className="flex w-full items-start gap-2.5">
																	<ChevronRight
																		className="text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]:rotate-90"
																		aria-hidden="true"
																		strokeWidth={2}
																	/>
																	<span
																		className="text-muted-foreground/60 mt-0.5 shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
																		aria-hidden="true"
																	>
																		{String(index + 1).padStart(2, '0')}
																	</span>
																	<div className="flex min-w-0 flex-1 flex-col gap-1">
																		<h3 className="truncate text-[14px] font-medium leading-tight tracking-[-0.005em]">
																			{workshop.fields.title}
																		</h3>
																		<span className="text-muted-foreground/70 truncate font-mono text-[10px] font-medium uppercase tracking-wider">
																			{workshopDateString
																				? `Available from ${workshopDateString}`
																				: 'Available today'}
																		</span>
																	</div>
																</div>
															</AccordionTrigger>
															{workshop.resources &&
																workshop.resources.length > 0 && (
																	<AccordionContent className="border-t pb-0">
																		<ol className="divide-border list-inside list-none divide-y">
																			<WorkshopListRowRenderer
																				workshop={workshop}
																			/>
																		</ol>
																	</AccordionContent>
																)}
														</AccordionItem>
													</Accordion>
												</ModuleProgressProvider>
											</li>
										)
									})}
								</ul>
								<div className="bg-stripes hidden min-h-0 w-4 shrink-0 border-y border-l sm:flex" />
							</div>
						</div>
					</div>
					<CohortSidebar cohort={displayCohort}>
						{fields?.image && (
							<CldImage
								className="hidden lg:flex"
								width={383}
								height={204}
								src={fields?.image}
								alt={fields?.title}
							/>
						)}
						{/* <CohortDetails cohort={displayCohort} /> */}
						{hasCohortAccess ? (
							<div>
								<div className="flex h-12 items-center border-b px-4 py-3 text-[14px] font-semibold tracking-tight">
									Workshops
								</div>
								<ol className="divide-border flex flex-col divide-y">
									{displayWorkshops.map((workshop, index) => {
										const moduleProgressLoader =
											workshopProgressMap.get(workshop.fields.slug) ||
											Promise.resolve(null)
										return (
											<li key={workshop.id}>
												<ModuleProgressProvider
													moduleProgressLoader={moduleProgressLoader}
												>
													<Accordion type="multiple">
														<AccordionItem
															value={workshop.id}
															className="data-[state=open]:bg-muted/60 transition-colors ease-out"
														>
															<WorkshopSidebarItem
																index={index + 1}
																workshop={workshop}
															/>
															<AccordionContent className="pb-0">
																<ol className="divide-border list-inside list-none divide-y border-t">
																	<WorkshopListRowRenderer
																		workshop={workshop}
																	/>
																</ol>
															</AccordionContent>
														</AccordionItem>
													</Accordion>
												</ModuleProgressProvider>
											</li>
										)
									})}
								</ol>
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
							/>
						) : null}
					</CohortSidebar>
				</div>
				{/* <CohortSidebarMobile cohort={displayCohort} /> */}
			</main>
		</LayoutClient>
	)
}

const WorkshopListRowRenderer = ({
	workshop,
	className,
}: {
	workshop: Workshop
	className?: string
}) => {
	const workshopNavDataLoader = getCachedWorkshopNavigation(
		workshop.fields.slug,
	)

	return (
		<WorkshopNavigationProvider workshopNavDataLoader={workshopNavDataLoader}>
			<WorkshopLessonList workshop={workshop} className={className} />
		</WorkshopNavigationProvider>
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
