'use client'

import React from 'react'
import { useParams } from 'next/navigation'
import Spinner from '@/components/spinner'
import { MenuIcon } from 'lucide-react'

import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { findSectionIdForResourceSlug } from '@/lib/content-navigation'

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
			titleHref={`/${list.fields.slug}`}
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

export function MobileListResourceNavigation() {
	const { list } = useList()

	if (!list) return null

	return (
		<Sheet>
			<SheetTrigger className="bg-card/90 border-foreground/10 fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded border px-3 py-2 shadow-lg backdrop-blur-md xl:hidden dark:bg-gray-800/80">
				<MenuIcon className="size-4" /> Lessons
			</SheetTrigger>
			<SheetContent side="left" className="overflow-y-auto px-0 pt-0">
				<SheetHeader>
					<SheetTitle className="sr-only">{list.fields.title}</SheetTitle>
				</SheetHeader>
				<ListResourceNavigation className="relative top-0 block h-full w-full max-w-full border-r-0 border-t-0 bg-transparent text-sm xl:hidden" />
			</SheetContent>
		</Sheet>
	)
}
