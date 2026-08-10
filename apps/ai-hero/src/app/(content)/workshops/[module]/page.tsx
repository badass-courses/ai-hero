import * as React from 'react'
import { Suspense } from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import { EditWorkshopButton } from '@/app/(content)/workshops/_components/edit-workshop-button'
import { WorkshopResourceList } from '@/app/(content)/workshops/_components/workshop-resource-list'
import {
	GetAccessButton,
	StartLearningWorkshopButton,
	StartLearningWorkshopButtonSkeleton,
	WorkshopGitHubRepoLink,
} from '@/app/(content)/workshops/_components/workshop-user-actions'
import { Contributor } from '@/components/contributor'
import { TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import { Share } from '@/components/share'
import config from '@/config'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { env } from '@/env.mjs'
import { ModuleProgressProvider } from '@/app/(content)/_components/module-progress-provider'
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
import { generateGridPattern } from '@/utils/generate-grid-pattern'
import { getAbilityForResource } from '@/utils/get-current-ability-rules'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import { and, eq } from 'drizzle-orm'
import { Share2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Course } from 'schema-dts'

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
	Skeleton,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { InlineBuyButton } from '../_components/inline-mdx-pricing'
import WorkshopBreadcrumb from '../_components/workshop-breadcrumb'
import WorkshopImage from '../_components/workshop-image'
import { WorkshopPricingClient } from '../_components/workshop-pricing'
import { WorkshopPricing } from '../_components/workshop-pricing-server'
import { WorkshopDraftBanner } from '../_components/workshop-draft-banner'
import { WorkshopInterestCta } from '../_components/workshop-interest-cta'
import { WorkshopNotifyButton } from '../_components/workshop-notify-button'
import { WorkshopSidebar } from '../_components/workshop-sidebar'
import { WorkshopStatePreviewBar } from '../_components/workshop-state-preview'
import { parseWorkshopPreviewState } from '../_components/workshop-state-preview-shared'
import { Certificate } from '../../_components/module-certificate-container'

type Props = {
	params: Promise<{ module: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export async function generateStaticParams() {
	const workshops = await db.query.contentResource.findMany({
		where: and(eq(contentResource.type, 'workshop')),
	})

	return workshops
		.filter((workshop) => Boolean(workshop.fields?.slug))
		.map((workshop) => ({
			module: workshop.fields?.slug,
		}))
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
					url: `${env.NEXT_PUBLIC_URL}/api/og/default?title=${workshop.fields?.title}`,
				},
				// getOGImageUrlForResource(
				// 	workshop as unknown as ContentResource & {
				// 		fields?: { slug: string }
				// 	},
				// ),
			],
		},
	}
}

export default async function ModulePage(props: Props) {
	const searchParams = await props.searchParams
	const params = await props.params
	const workshop = await getCachedMinimalWorkshop(params.module)

	const abilityLoader = getAbilityForResource(undefined, params.module)

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

	// ─── DEV-ONLY state preview fixture ──────────────────────────────────────
	// `?state=waitlist|pricing|purchased|in-progress|completed|no-product`
	// forces the landing page into that state for local design work. Parses to
	// undefined outside development; see workshop-state-preview.tsx. Not
	// production code.
	const previewState = parseWorkshopPreviewState(searchParams.state)
	const previewAsVisitor =
		previewState === 'waitlist' ||
		previewState === 'pricing' ||
		previewState === 'no-product'
	const effectiveAbilityLoader = previewState
		? Promise.resolve({
				canViewWorkshop: !previewAsVisitor,
				canViewLesson: !previewAsVisitor,
				isPendingOpenAccess: false,
				canInviteTeam: false,
				isRegionRestricted: false,
				canCreate: false,
			})
		: abilityLoader
	const previewProgressLoader = (() => {
		if (!previewState) return null
		const lessons = flattenNavigationResources(navigation).filter(
			isCompletionTrackedResource,
		)
		const completedCount =
			previewState === 'completed'
				? lessons.length
				: previewState === 'in-progress'
					? Math.max(1, Math.floor(lessons.length / 3))
					: 0
		return Promise.resolve({
			completedLessons: lessons.slice(0, completedCount).map((lesson) => ({
				userId: 'preview',
				resourceId: lesson.id,
				completedAt: new Date(),
			})),
			nextResource: lessons[completedCount] ?? null,
			percentCompleted:
				lessons.length > 0
					? Math.ceil((completedCount / lessons.length) * 100)
					: 0,
			completedLessonsCount: completedCount,
			totalLessonsCount: lessons.length,
		})
	})()
	// ─────────────────────────────────────────────────────────────────────────

	// The actions bar (`Workshop Landing.dc.html` § "Actions bar"): free-standing
	// 46px/9px controls in a padded hairline-bounded row, one gold object at a
	// time. It lives INSIDE the content column so the sidebar's top edge and the
	// bar's top edge are the same line — the old full-width bar needed the
	// sidebar to pull itself up over the bar's empty cell with a `-mt-14`.
	const Links = ({ className }: { className?: string }) => {
		return (
			<div
				className={cn(
					'flex w-full flex-wrap items-center gap-2.5 border-b px-5 py-2.5 sm:px-8 lg:px-10',
					className,
				)}
			>
				<React.Suspense fallback={<StartLearningWorkshopButtonSkeleton />}>
					<GetAccessButton
						className="w-full sm:w-auto"
						abilityLoader={effectiveAbilityLoader}
					/>
					<StartLearningWorkshopButton
						className="w-full sm:w-auto"
						productType={product?.type}
						abilityLoader={effectiveAbilityLoader}
						moduleSlug={params.module}
						workshop={workshop}
					/>
					{workshop.fields?.github ? (
						<WorkshopGitHubRepoLink
							githubUrl={workshop.fields?.github}
							abilityLoader={effectiveAbilityLoader}
						/>
					) : null}
					<Dialog>
						<DialogTrigger asChild>
							<Button
								className="text-muted-foreground hover:text-foreground hover:bg-muted h-[46px] rounded-[9px] px-4 text-sm font-medium"
								variant="ghost"
								size="lg"
							>
								<Share2 className="mr-1 w-3" /> Share
							</Button>
						</DialogTrigger>
						<DialogContent
							lockScroll={false}
							className="max-w-[min(640px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl p-0"
						>
							<DialogTitle className="border-b px-6 py-5 text-xl">
								Share
							</DialogTitle>
							<Share
								variant="dialog"
								title={workshop.fields?.title}
								className="p-6"
							/>
						</DialogContent>
					</Dialog>
				</React.Suspense>
			</div>
		)
	}
	// DEV-ONLY: overrides the layout's real module progress for this page's
	// subtree so the preview can fake start / in-progress / completed.
	const PreviewProgress = ({ children }: { children: React.ReactNode }) =>
		previewProgressLoader ? (
			<ModuleProgressProvider
				key={previewState}
				moduleProgressLoader={previewProgressLoader}
			>
				{children}
			</ModuleProgressProvider>
		) : (
			<>{children}</>
		)

	const squareGridPattern = generateGridPattern(
		workshop.fields?.title || '',
		1000,
		800,
		0.8,
		true,
	)
	const product = await getCachedWorkshopProduct(params.module)
	const hasSelfPacedProduct = product?.type === 'self-paced'
	const shouldShowPricingSidebar = hasSelfPacedProduct || isPreLaunch

	// Whether the actions bar would hold any action for THIS viewer — the same
	// conditions its buttons check client-side, decided here so an empty bar
	// (a waitlist visitor: no access, nothing pending, no repo) renders as no
	// bar at all instead of a hairline-bounded row of padding around Share.
	const ability = await effectiveAbilityLoader
	const cohortParent =
		navigation?.parents?.[0]?.type === 'cohort' ? navigation.parents[0] : null
	const cohortSlug = cohortParent?.resources?.[0]?.resource?.fields?.slug
	const hasBarActions = Boolean(
		(ability.isPendingOpenAccess && workshop.fields?.startsAt) ||
			(ability.canViewWorkshop &&
				product?.type !== 'cohort' &&
				hasContent) ||
			(!ability.canViewWorkshop && cohortSlug) ||
			(ability.canViewWorkshop && workshop.fields?.github),
	)
	const { content: body } = await compileMDX(workshop.fields.body || '', {
		EnrollNow: (props) => (
			<WorkshopPricing moduleSlug={params.module} searchParams={searchParams}>
				{(workshopProps) => {
					if (workshopProps.hasPurchasedCurrentProduct) return null
					// allowPurchase forces the buy state; a pre-launch workshop instead
					// points at the sidebar interest-capture form.
					if (workshopProps.allowPurchase) {
						return (
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
						)
					}
					if (isPreLaunch) {
						return <WorkshopNotifyButton workshopSlug={params.module} />
					}
					return null
				}}
			</WorkshopPricing>
		),
	})

	return (
		<LayoutClient withContainer>
			<PreviewProgress>
			<main className="flex min-h-screen w-full flex-col">
				{isPreLaunch && (
					<React.Suspense fallback={null}>
						<WorkshopDraftBanner
							abilityLoader={abilityLoader}
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
								<WorkshopImage
									imageUrl={workshop.fields.coverImage.url}
									abilityLoader={effectiveAbilityLoader}
								/>
							)}
						</div>
					</div>
					<div className={cn('absolute right-0 top-0 z-0 w-full', {})}>
						<div
							className="bg-stripes opacity-8! h-[320px] w-full"
							aria-hidden="true"
						/>
						{/* <img
							src={squareGridPattern}
							alt=""
							aria-hidden="true"
							className="object-top-right hidden h-[320px] w-full overflow-hidden object-cover opacity-[0.05] saturate-0 sm:flex dark:opacity-[0.15]"
						/> */}
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
							{hasBarActions && <Links />}
							<div className="pt-10">
							<article className="prose dark:prose-invert sm:prose-lg lg:prose-lg prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-table:max-w-4xl prose-pre:max-w-4xl **:data-pre:max-w-4xl max-w-none px-5 pb-10 sm:px-8 lg:px-10">
								{workshop.fields?.body ? body : <p>No description found.</p>}
							</article>
							{hasSelfPacedProduct && hasContent && (
								<div className="">
									<hr className="border-border mb-6 mt-8 w-full" />
									<h3 className="mb-3 mt-5 px-5 text-xl font-bold sm:px-8 sm:text-2xl lg:px-10">
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
							{(
								previewState
									? previewState !== 'no-product'
									: shouldShowPricingSidebar
							) ? (
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
									<WorkshopPricing
										moduleSlug={params.module}
										searchParams={
											// Preview: `allowPurchase` is the commerce chain's own
											// state-forcing mechanism, so the pricing preview rides it.
											previewState === 'pricing'
												? { ...searchParams, allowPurchase: 'true' }
												: searchParams
										}
									>
										{(pricingProps) => {
											// allowPurchase always forces the buy state; otherwise a
											// pre-launch workshop shows the interest-capture form.
											// A dev preview state overrides both decisions outright.
											const showInterestCapture = previewState
												? previewState === 'waitlist'
												: isPreLaunch &&
													!pricingProps.allowPurchase &&
													!pricingProps.hasPurchasedCurrentProduct
											const showBuy = previewState
												? previewState === 'pricing'
												: pricingProps.allowPurchase &&
													!pricingProps.hasPurchasedCurrentProduct
											return pricingProps.product ? (
												<>
													<WorkshopSidebar
														pricingProps={pricingProps}
														workshop={workshop}
														interestCapture={showInterestCapture}
														purchased={
															!showBuy &&
															!showInterestCapture &&
															Boolean(
																previewState ||
																	pricingProps.hasPurchasedCurrentProduct,
															)
														}
													>
														{showBuy ? (
															<>
																<WorkshopPricingClient
																	className="bg-card"
																	searchParams={
																		// Preview: the client half of the commerce
																		// chain re-reads the URL params, so the forced
																		// `allowPurchase` has to ride here too, not
																		// only into <WorkshopPricing>.
																		previewState === 'pricing'
																			? Promise.resolve({
																					...searchParams,
																					allowPurchase: 'true',
																				})
																			: props.searchParams
																	}
																	{...pricingProps}
																	hasPurchasedCurrentProduct={
																		previewState === 'pricing'
																			? false
																			: pricingProps.hasPurchasedCurrentProduct
																	}
																/>
															</>
														) : showInterestCapture ? (
															<WorkshopInterestCta
																workshopSlug={params.module}
																workshopTitle={workshop.fields?.title}
																forceVisible={previewState === 'waitlist'}
															/>
														) : (
															<>
																<SidebarListHeader />
																<WorkshopResourceList
																	isCollapsible={false}
																	className="border-r-0! w-full max-w-none"
																	withHeader={false}
																	maxHeight="h-auto"
																	wrapperClassName="overflow-hidden pb-0 hidden md:block"
																/>
																<div className="p-3">
																	<Certificate
																		resourceSlugOrId={params.module}
																	/>
																</div>
															</>
														)}
													</WorkshopSidebar>
												</>
											) : showInterestCapture ? (
												<WorkshopSidebar
													workshop={workshop}
													pricingProps={pricingProps}
													interestCapture={showInterestCapture}
												>
													<WorkshopInterestCta
														workshopSlug={params.module}
														workshopTitle={workshop.fields?.title}
														forceVisible={previewState === 'waitlist'}
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
										}}
									</WorkshopPricing>
								</React.Suspense>
							) : (
								<WorkshopSidebar workshop={workshop}>
									<SidebarListHeader />
									<WorkshopResourceList
										isCollapsible={false}
										className="border-r-0! w-full max-w-none"
										withHeader={false}
										maxHeight="h-auto"
										wrapperClassName="overflow-hidden pb-0"
									/>
								</WorkshopSidebar>
							)}
						</div>
					</div>
					{/* The bar again at the end of the read — same object, so a reader
					    who finished the argument doesn't scroll back up to act on it.
					    The empty sidebar cell keeps the column hairline running. */}
					{!isPreLaunch && hasBarActions && workshop?.fields?.body && (
						<div className="grid-cols-6 border-t md:grid">
							<Links className="col-span-4 border-b-0" />
							<div
								className="col-span-2 hidden border-l md:block"
								aria-hidden="true"
							/>
						</div>
					)}
				</>
				<WorkshopStatePreviewBar
					moduleSlug={params.module}
					current={previewState}
				/>
			</main>
			</PreviewProgress>
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
