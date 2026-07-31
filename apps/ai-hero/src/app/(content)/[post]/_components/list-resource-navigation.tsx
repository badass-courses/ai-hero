'use client'

import React from 'react'
import { useParams } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import Spinner from '@/components/spinner'
import { flattenListResources } from '@/utils/get-nextup-resource-from-list'
import { ChevronUp, MenuIcon } from 'lucide-react'

import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { findSectionIdForResourceSlug } from '@/lib/content-navigation'
import { listHomeHref } from '@/lib/list-home'

import { ResourceListView } from '../../_components/resource-list-view'
import { useList } from './list-provider'
import { useProgress } from './progress-provider'

export default function ListResourceNavigation({
	className,
	withHeader = true,
}: {
	className?: string
	withHeader?: boolean
}) {
	const params = useParams()
	const { list, isLoading: isListLoading, currentPostHasVideo } = useList()
	const { progress } = useProgress()

	if (isListLoading) {
		return (
			<div
				className={cn(
					'bg-muted/50 scrollbar-thin top-(--nav-height) sticky flex h-[calc(100vh-var(--nav-height))] w-full max-w-[320px] shrink-0 items-start justify-start overflow-y-auto border-r p-5',
					className,
				)}
			>
				<div className="flex items-center gap-3">
					<Spinner className="w-5" />
					<span className="font-mono text-xs">loading list..</span>
				</div>
			</div>
		)
	}

	if (!list) return null

	const currentSlug = typeof params.post === 'string' ? params.post : undefined
	const currentSectionId = findSectionIdForResourceSlug(list, currentSlug)

	return (
		<ResourceListView
			title={list.fields.title}
			titleHref={listHomeHref(list.fields.slug)}
			moduleId={list.id}
			resources={list.resources}
			currentSlug={currentSlug}
			defaultOpenSectionId={currentSectionId}
			completedLessons={progress?.completedLessons}
			buildLessonHref={(slug) => `/${slug}`}
			withHeader={withHeader}
			showAutoplay={currentPostHasVideo}
			isCollapsible={false}
			stickyTopClassName="top-(--nav-height)"
			className={cn('hidden xl:block', className)}
		/>
	)
}

/**
 * The lesson list, on the screens where the hub sidebar is not there to carry
 * it.
 *
 * Two things were wrong with the floating pill this replaces. It hid at `xl`
 * while the hub sidebar appears at `md`, so between 768px and 1280px — most
 * laptops — the same list was reachable twice, once in the rail and once from a
 * button pinned over the article. And the pill said only "Lessons": a reader
 * dropped on a lesson from search got no sense of which series they had landed
 * in or how far through it they were, which is the one thing that actually
 * needs saying on a small screen.
 *
 * The bar follows `SkillStickyAction` (Mobile Patterns § 3a): fixed to the
 * bottom edge, safe-area inset on the outer element so the home-indicator strip
 * is filled by the bar's own background rather than by sliding content.
 *
 * `variant` exists because a skill page already pins its install action to the
 * bottom, and two full-width bars cannot both own that edge. There the compact
 * trigger floats above the install bar instead, which is also the honest
 * hierarchy: on a skill page, installing is the primary action and the page
 * list is secondary.
 */
export function MobileListResourceNavigation({
	label = 'Lessons',
	variant = 'bar',
}: {
	label?: 'Lessons' | 'Pages'
	/** `floating` on pages that already own the bottom edge — see above. */
	variant?: 'bar' | 'floating'
}) {
	const params = useParams()
	const { list } = useList()

	// Clearance for a `fixed` bar belongs on the document: the footer is rendered
	// by `HubLayout`, above this component in the tree, so a spacer rendered here
	// would land before the footer and the bar would still cover its last row.
	// Same reasoning as `SkillStickyAction`; the class is separate because the
	// two bars are different heights.
	React.useEffect(() => {
		if (variant !== 'bar' || !list) return
		document.body.classList.add('has-list-bar')
		return () => document.body.classList.remove('has-list-bar')
	}, [variant, list])

	if (!list) return null

	const currentSlug = typeof params.post === 'string' ? params.post : undefined
	// A sectioned list holds sections in `resources`, not lessons, so counting it
	// directly disagrees with the header on the same page. Flatten first — same
	// helper `[post]/page.tsx` uses for its own "03 / 87".
	const lessons = flattenListResources(list)
	const index = lessons.findIndex(
		(entry) => entry.resource.fields?.slug === currentSlug,
	)
	const current = index >= 0 ? lessons[index] : undefined
	const position =
		index >= 0 && lessons.length > 1
			? `${String(index + 1).padStart(2, '0')} / ${String(lessons.length).padStart(2, '0')}`
			: null

	return (
		<Sheet>
			{variant === 'floating' ? (
				<SheetTrigger className="bg-card/90 border-foreground/10 fixed bottom-20 right-5 z-50 flex items-center gap-2 rounded-[9px] border px-3 py-2 shadow-lg backdrop-blur-md md:hidden dark:bg-gray-800/80">
					<MenuIcon className="size-4" /> {label}
				</SheetTrigger>
			) : (
				<div className="bg-background/95 border-border fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden print:hidden">
					<SheetTrigger
						aria-label={`${label} in ${list.fields.title}`}
						className="focus-visible:ring-ring flex w-full items-center gap-3 px-[18px] py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
					>
						<MenuIcon
							aria-hidden
							className="text-[color:var(--ah-fg-subtle)] size-4 flex-none"
						/>
						<span className="min-w-0 flex-1">
							<span
								className={cn(
									TYPE.groupLabel,
									'block truncate',
								)}
							>
								{list.fields.title}
							</span>
							{current?.resource.fields?.title ? (
								<span className={cn(TYPE.bodyTight, 'block truncate')}>
									{current.resource.fields.title}
								</span>
							) : (
								<span className={cn(TYPE.bodyTight, 'block truncate')}>
									{label}
								</span>
							)}
						</span>
						{position ? (
							<span
								className={cn(
									TYPE.metaMark,
									'flex-none',
								)}
							>
								{position}
							</span>
						) : null}
						<ChevronUp
							aria-hidden
							className="text-[color:var(--ah-fg-subtle)] size-4 flex-none"
						/>
					</SheetTrigger>
				</div>
			)}
			<SheetContent side="left" className="overflow-y-auto px-0 pt-0">
				<SheetHeader>
					<SheetTitle className="sr-only">{list.fields.title}</SheetTitle>
				</SheetHeader>
				<ListResourceNavigation className="relative top-0 block h-full w-full max-w-full border-r-0 border-t-0 bg-transparent text-sm xl:hidden" />
			</SheetContent>
		</Sheet>
	)
}
