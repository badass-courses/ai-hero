import * as React from 'react'
import { Suspense } from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import { EditWorkshopButton } from '@/app/(content)/workshops/_components/edit-workshop-button'
import {
	WorkshopAccessBoundary,
	WorkshopSidebarAccessBoundary,
} from '@/app/(content)/workshops/_components/workshop-access-boundary'
import { WorkshopResourceList } from '@/app/(content)/workshops/_components/workshop-resource-list'
import { TeamWelcomeVideo } from '@/app/(content)/workshops/_components/team-welcome-video'
import { WorkshopActionsBar } from '@/app/(content)/workshops/_components/workshop-user-actions'
import { Contributor } from '@/components/contributor'
import { DiscountDeadline } from '@/components/pricing/discount-deadline'
import { PricingInline } from '@/components/pricing/pricing-inline'
import { TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import config from '@/config'
import { env } from '@/env.mjs'
import {
	flattenNavigationResources,
	getFirstResourceSlug,
	isCompletionTrackedResource,
} from '@/lib/content-navigation'
import {
	getCachedMinimalWorkshop,
	getCachedWorkshopNavigation,
	getCachedWorkshopProduct,
} from '@/lib/workshops-query'
import { compileMDX } from '@/utils/compile-mdx'
import { Markdown as ReactMarkdown } from '@/components/markdown'
import { Course } from 'schema-dts'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { InlineBuyButton } from '../_components/inline-mdx-pricing'
import WorkshopBreadcrumb from '../_components/workshop-breadcrumb'
import WorkshopImage from '../_components/workshop-image'
import {
	WorkshopPricingClient,
	WorkshopPricingFallback,
} from '../_components/workshop-pricing'
import { PublicWorkshopPricing } from '../_components/workshop-public-pricing-server'
import { WorkshopDraftBanner } from '../_components/workshop-draft-banner'
import { WorkshopInterestCta } from '../_components/workshop-interest-cta'
import { WorkshopNotifyButton } from '../_components/workshop-notify-button'
import { WorkshopSidebar } from '../_components/workshop-sidebar'
import { Certificate } from '../../_components/module-certificate-container'

type Props = {
	params: Promise<{ module: string }>
}

export const revalidate = 3600
export const dynamicParams = true
export const dynamic = 'force-static'

export async function generateStaticParams() {
	// Build no workshop inventory here. The first request creates the ISR entry.
	// This avoids a build-time fan-out that can itself overwhelm the content
	// database during an active crawl.
	return []
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const workshop = await getCachedMinimalWorkshop(params.module)

	if (!workshop) {
		return parent as Metadata
	}

	return {
		title: workshop.fields?.title,
		description: workshop.fields?.description,
		alternates: {
			canonical: `/workshops/${params.module}`,
		},
		openGraph: {
			images: [
				{
					// The cover art IS the share card — it already carries the title
					// and the "build production-grade software" framing. The generated
					// title card is only the fallback for workshops without art.
					url:
						workshop.fields?.coverImage?.url ||
						`${env.NEXT_PUBLIC_URL}/api/og/default?title=${workshop.fields?.title}`,
				},
			],
		},
	}
}

export default async function ModulePage(props: Props) {
	const params = await props.params
	const workshop = await getCachedMinimalWorkshop(params.module)

	if (!workshop) {
		notFound()
	}

	// Pre-launch: a not-yet-published workshop we expose as an interest-capture
	// landing page (Matt drives traffic here to get people on the list).
	const isPreLaunch = workshop.fields?.state !== 'published'
	const navigation = await getCachedWorkshopNavigation(params.module)
	const hasContent = Boolean(getFirstResourceSlug(navigation))

	// Facts for the sidebar list's header (prototype: "27 lessons · 5 sections").
	const trackedLessonCount = flattenNavigationResources(navigation).filter(
		isCompletionTrackedResource,
	).length
	const sectionCount =
		navigation?.resources?.filter((row) => row.resource.type === 'section')
			.length ?? 0

	// Raised header over the content list when the sidebar IS the content list
	// (purchased / no-product): names the thing the list belongs to, in the
	// column the reader is scanning. The list itself is hidden on mobile there,
	// so the header hides with it.
	const SidebarListHeader = () => (
		<div className="bg-card hidden flex-col gap-0.5 border-b px-4 py-3.5 md:flex">
			<span className={cn(TYPE.meta, 'font-semibold')}>
				{workshop.fields?.title}
			</span>
			<span className={cn(TYPE.metaMark)}>
				{trackedLessonCount} lessons
				{sectionCount > 0 ? ` · ${sectionCount} sections` : ''}
			</span>
		</div>
	)

	const product = await getCachedWorkshopProduct(params.module)
	const hasSelfPacedProduct = product?.type === 'self-paced'
	const shouldShowPricingSidebar = hasSelfPacedProduct || isPreLaunch
	const bodySource = workshop.fields.body || ''
	// The body placing the curriculum itself replaces the auto-appended list.
	// Code fences/inline code are stripped first so a body that merely *shows*
	// the tag in an example doesn't suppress the real list, and the tag must
	// close or take props so `<WorkshopContentListFoo>` doesn't match.
	const bodyHasInlineContentList = /<WorkshopContentList[\s/>]/.test(
		bodySource.replace(/```[\s\S]*?```|`[^`\n]*`/g, ''),
	)
	const { content: body } = await compileMDX(bodySource, {
		// A welcome video for ONE organization, keyed by resource id. Safe on a
		// `force-static` page because the tag carries no playback id: the client
		// component asks `/api/restricted-videos/:id`, which reads the viewer's
		// session, and renders nothing for everybody else.
		TeamWelcomeVideo: ({
			resourceId,
			title,
		}: {
			resourceId: string
			title?: string
		}) => <TeamWelcomeVideo resourceId={resourceId} title={title} />,
		// Dynamic commerce copy: same vocabulary as the cohort page
		// (content/cohort-copy.mdx). All render from the cached public pricing
		// props, so they stay correct on the static page: PricingInline shows
		// live prices, HasDiscount gates sale copy on an active default coupon,
		// DiscountDeadline names the sale's last day in Pacific time.
		PricingInline: ({ type }: { type: 'original' | 'discounted' }) => (
			<PublicWorkshopPricing moduleSlug={params.module}>
				{(workshopProps) => (
					<PricingInline
						type={type}
						pricingDataLoader={workshopProps.pricingDataLoader}
					/>
				)}
			</PublicWorkshopPricing>
		),
		DiscountDeadline: ({ format }: { format?: 'short' | 'long' }) => (
			<PublicWorkshopPricing moduleSlug={params.module}>
				{(workshopProps) => (
					<DiscountDeadline
						format={format}
						expires={workshopProps.defaultCoupon?.expires ?? null}
					/>
				)}
			</PublicWorkshopPricing>
		),
		HasDiscount: ({
			children,
			fallback,
		}: {
			children: React.ReactNode
			fallback?: React.ReactNode
		}) => (
			<PublicWorkshopPricing moduleSlug={params.module}>
				{(workshopProps) =>
					workshopProps.defaultCoupon ? (
						<>{children}</>
					) : (
						<>{fallback ?? null}</>
					)
				}
			</PublicWorkshopPricing>
		),
		// Inline curriculum: the same styled sections/lessons list the page
		// appends under the body in the buy state, but placed exactly where the
		// copy calls for it. When the body uses it, the auto-appended copy below
		// the article is suppressed so the list appears once.
		WorkshopContentList: () =>
			hasContent ? (
				<div className="not-prose border-border my-8 max-w-4xl overflow-hidden rounded-md border">
					<WorkshopResourceList
						isCollapsible={false}
						defaultAllClosed
						className="border-r-0! [&_button]:rounded-none! [&_button]:bg-card! [&_button]:hover:text-primary [&_button]:hover:bg-card w-full max-w-none [&_button]:cursor-pointer [&_ol>li]:last-of-type:[&_button]:border-b-0"
						withHeader={false}
						maxHeight="h-auto"
						wrapperClassName="overflow-hidden pb-0"
					/>
				</div>
			) : null,
		EnrollNow: (props) => (
			<PublicWorkshopPricing moduleSlug={params.module}>
				{(workshopProps) => {
					// allowPurchase forces the buy state; a pre-launch workshop instead
					// points at the sidebar interest-capture form.
					if (workshopProps.allowPurchase) {
						return (
							<WorkshopAccessBoundary
								member={null}
								anonymous={
									<InlineBuyButton
										resource={workshop}
										pricingDataLoader={workshopProps.pricingDataLoader}
										pricingProps={workshopProps as any}
										centered={false}
										resourceType="workshop"
										pricingOptions={{
											withTitle: false,
											withImage: false,
										}}
									/>
								}
							/>
						)
					}
					if (isPreLaunch) {
						return <WorkshopNotifyButton workshopSlug={params.module} />
					}
					return null
				}}
			</PublicWorkshopPricing>
		),
	})

	// The no-pricing sidebar is the content list either way; `purchased` only
	// changes the mobile bar's offer (Continue instead of nothing).
	const listSidebar = (purchased: boolean) => (
		<WorkshopSidebar workshop={workshop} purchased={purchased}>
			<SidebarListHeader />
			<WorkshopResourceList
				isCollapsible={false}
				className="border-r-0! w-full max-w-none"
				withHeader={false}
				maxHeight="h-auto"
				wrapperClassName="overflow-hidden pb-0"
			/>
		</WorkshopSidebar>
	)

	return (
		<LayoutClient withContainer>
			<main className="flex min-h-screen w-full flex-col">
				{isPreLaunch && (
					<React.Suspense fallback={null}>
						<WorkshopDraftBanner
							state={workshop.fields?.state}
							type={workshop.type}
						/>
					</React.Suspense>
				)}
				<WorkshopMetadata
					title={workshop.fields?.title || ''}
					description={workshop.fields?.description || ''}
					imageUrl={workshop.fields?.coverImage?.url}
					slug={params.module}
				/>
				{/* The cover bleeds to the container's top, right and bottom edges,
				    square-cornered, on the same six-column rhythm as the body below —
				    its left edge continues the sidebar's hairline. The text column
				    keeps the page's padding and vertical centering. */}
				<header className="relative flex items-center justify-center overflow-hidden">
					<div className="relative z-10 mx-auto flex h-full w-full flex-col-reverse items-center gap-5 md:grid md:grid-cols-6 md:items-stretch md:gap-0">
						<div className="col-span-4 flex w-full shrink-0 flex-col items-center px-5 pb-10 md:items-start md:justify-center md:px-8 md:py-10 lg:px-10">
							<WorkshopBreadcrumb />
							<h1 className="w-full text-center text-3xl font-bold tracking-tight sm:text-4xl md:text-left lg:text-5xl dark:text-white">
								{workshop.fields?.title}
							</h1>
							{workshop.fields?.description && (
								<ReactMarkdown
									className={cn(
										'mt-4 text-balance text-center leading-tight sm:text-lg md:text-left lg:text-xl',
									)}
									components={{
										p: ({ children }) => (
											<h2 className="font-normal">{children}</h2>
										),
									}}
								>
									{workshop.fields?.description}
								</ReactMarkdown>
							)}
							<div className="mt-5 flex items-center gap-2 sm:mt-10">
								<Contributor />
							</div>
						</div>
						<div className="relative col-span-2 w-full">
							{workshop.fields?.coverImage?.url && (
								<WorkshopImage imageUrl={workshop.fields.coverImage.url} />
							)}
						</div>
					</div>
					<div className={cn('absolute right-0 top-0 z-0 w-full', {})}>
						<div
							className="bg-stripes opacity-8! h-[320px] w-full"
							aria-hidden="true"
						/>
						<div
							className="to-background via-background bg-linear-to-bl absolute left-0 top-0 z-10 h-full w-full from-transparent"
							aria-hidden="true"
						/>
					</div>
					<Suspense fallback={null}>
						<EditWorkshopButton
							className="absolute right-5 top-5 z-10"
							moduleType="workshop"
							moduleSlug={params.module}
							product={product}
						/>
					</Suspense>
				</header>

				<>
					<div className="mx-auto flex w-full grow grid-cols-6 flex-col border-t md:grid">
						<div className="col-span-4 flex flex-col border-b md:border-b-0">
							<Suspense fallback={null}>
								<WorkshopActionsBar
									workshop={workshop}
									moduleSlug={params.module}
									productType={product?.type}
								/>
							</Suspense>
							<div className="pt-10">
								<article className="prose dark:prose-invert sm:prose-lg lg:prose-lg prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-table:max-w-4xl prose-pre:max-w-4xl **:data-pre:max-w-4xl max-w-none px-5 pb-10 sm:px-8 lg:px-10">
									{workshop.fields?.body ? body : <p>No description found.</p>}
								</article>
								{hasSelfPacedProduct &&
								hasContent &&
								!bodyHasInlineContentList && (
									<div className="">
										<hr className="border-border mb-6 mt-8 w-full" />
										<h3
											className={cn(
												TYPE.subhead,
												'mb-3 mt-5 px-5 sm:px-8 lg:px-10',
											)}
										>
											Content
										</h3>
										<WorkshopResourceList
											isCollapsible={false}
											className="border-r-0! [&_button]:rounded-none! [&_button]:bg-card! [&_button]:hover:text-primary [&_button]:hover:bg-card w-full max-w-none [&_button]:cursor-pointer [&_ol>li]:last-of-type:[&_button]:border-b-0"
											withHeader={false}
											maxHeight="h-auto"
											wrapperClassName="overflow-hidden pb-0 border-t border-border"
										/>
									</div>
								)}
							</div>
						</div>
						<div className="bg-background relative z-20 col-span-2 flex h-full flex-col md:border-l">
							{shouldShowPricingSidebar ? (
								<React.Suspense
									fallback={
										<div className="bg-background relative z-10 flex w-full flex-col gap-2 p-5 pb-16">
											<Skeleton className="bg-accent h-10 w-full" />
											<Skeleton className="bg-accent h-10 w-full" />
											<Skeleton className="bg-accent h-10 w-full" />
											<Skeleton className="bg-accent h-10 w-full" />
										</div>
									}
								>
									<PublicWorkshopPricing moduleSlug={params.module}>
										{(pricingProps) => {
											// allowPurchase always forces the buy state; otherwise a
											// pre-launch workshop shows the interest-capture form.
											const showInterestCapture =
												isPreLaunch && !pricingProps.allowPurchase
											const memberSidebar = (
												<WorkshopSidebar workshop={workshop} purchased>
													<SidebarListHeader />
													<WorkshopResourceList
														isCollapsible={false}
														className="border-r-0! w-full max-w-none"
														withHeader={false}
														maxHeight="h-auto"
														wrapperClassName="overflow-hidden pb-0 hidden md:block"
													/>
													<div className="p-3">
														<Certificate resourceSlugOrId={params.module} />
													</div>
												</WorkshopSidebar>
											)
											const pricingWidget = (
												<React.Suspense
													fallback={
														<WorkshopPricingFallback
															className="bg-card"
															{...pricingProps}
														/>
													}
												>
													<WorkshopPricingClient
														className="bg-card"
														{...pricingProps}
													/>
												</React.Suspense>
											)
											const anonymousSidebar = pricingProps.product ? (
												<WorkshopSidebar
													pricingProps={pricingProps}
													workshop={workshop}
													interestCapture={showInterestCapture}
												>
													{pricingProps.allowPurchase ? (
														pricingWidget
													) : showInterestCapture ? (
														<WorkshopInterestCta
															workshopSlug={params.module}
															workshopTitle={workshop.fields?.title}
														/>
													) : (
														<>
															<SidebarListHeader />
															<WorkshopResourceList
																isCollapsible={false}
																className="border-r-0! w-full max-w-none"
																withHeader={false}
																maxHeight="h-auto"
																wrapperClassName="overflow-hidden pb-0"
															/>
														</>
													)}
												</WorkshopSidebar>
											) : showInterestCapture ? (
												<WorkshopSidebar
													workshop={workshop}
													pricingProps={pricingProps}
													interestCapture
												>
													<WorkshopInterestCta
														workshopSlug={params.module}
														workshopTitle={workshop.fields?.title}
													/>
												</WorkshopSidebar>
											) : (
												<WorkshopResourceList
													isCollapsible={false}
													className="border-r-0! w-full max-w-none"
													withHeader={false}
													maxHeight="h-auto"
													wrapperClassName="overflow-hidden pb-0"
												/>
											)
											const forcedPurchaseSidebar = pricingProps.product ? (
												<WorkshopSidebar
													pricingProps={{
														...pricingProps,
														allowPurchase: true,
													}}
													workshop={workshop}
												>
													<React.Suspense
														fallback={
															<WorkshopPricingFallback
																className="bg-card"
																searchParams={{ allowPurchase: 'true' }}
																{...pricingProps}
															/>
														}
													>
														<WorkshopPricingClient
															className="bg-card"
															{...pricingProps}
														/>
													</React.Suspense>
												</WorkshopSidebar>
											) : (
												anonymousSidebar
											)

											return (
												<React.Suspense
													fallback={
														<WorkshopAccessBoundary
															anonymous={anonymousSidebar}
															member={memberSidebar}
														/>
													}
												>
													<WorkshopSidebarAccessBoundary
														anonymous={anonymousSidebar}
														member={memberSidebar}
														forcedPurchase={forcedPurchaseSidebar}
													/>
												</React.Suspense>
											)
										}}
									</PublicWorkshopPricing>
								</React.Suspense>
							) : (
								<WorkshopAccessBoundary
									anonymous={listSidebar(false)}
									member={listSidebar(true)}
								/>
							)}
						</div>
					</div>
					{/* The bar again at the end of the read — same object, so a reader
					    who finished the argument doesn't scroll back up to act on it. */}
					{!isPreLaunch && workshop?.fields?.body && (
						<Suspense fallback={null}>
							<WorkshopActionsBar
								workshop={workshop}
								moduleSlug={params.module}
								productType={product?.type}
								variant="bottom"
							/>
						</Suspense>
					)}
				</>
			</main>
		</LayoutClient>
	)
}

const WorkshopMetadata = ({
	title,
	description,
	imageUrl,
	slug,
}: {
	title: string
	description: string
	imageUrl?: string
	slug: string
}) => {
	const jsonLd: Course = {
		'@type': 'Course',
		name: title,
		author: config.author,
		creator: {
			'@type': 'Person',
			name: config.author,
		},
		description: description,
		...(imageUrl && { thumbnailUrl: imageUrl }),
		url: `${env.NEXT_PUBLIC_URL}/workshops/${slug}`,
	}

	return (
		<script
			type="application/ld+json"
			dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
		/>
	)
}
