'use client'

import * as React from 'react'
import Link from 'next/link'
import { type AppAbility } from '@/ability'
import { useScrollToActive } from '@/hooks/use-scroll-to-active'
import { subject } from '@casl/ability'
import {
	Check,
	ChevronRight,
	Code2,
	Lock,
	PanelLeftClose,
	PanelLeftOpen,
	Pen,
	Play,
} from 'lucide-react'

import type {
	ContentResource,
	ContentResourceResource,
	ModuleProgress,
} from '@coursebuilder/core/schemas'
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
	Button,
	ScrollArea,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import { AutoPlayToggle } from './autoplay-toggle'

export type ResourceListViewProps = {
	title: string
	titleHref: string
	breadcrumb?: { label: string; href: string }

	moduleId: string
	resources?: ContentResourceResource[]
	defaultOpenSectionId?: string | null

	currentSlug?: string
	isOnSolution?: boolean
	completedLessons?: ModuleProgress['completedLessons']

	buildLessonHref: (slug: string) => string
	buildEditHref?: (slug: string) => string

	ability?: AppAbility
	abilityStatus?: 'error' | 'success' | 'pending'

	isCollapsible?: boolean
	isCollapsed?: boolean
	onToggleCollapse?: (next: boolean) => void

	withHeader?: boolean
	showAutoplay?: boolean

	className?: string
	wrapperClassName?: string
	maxHeight?: string
	stickyTopClassName?: string
}

export function ResourceListView({
	title,
	titleHref,
	breadcrumb,
	moduleId,
	resources,
	defaultOpenSectionId,
	currentSlug,
	isOnSolution = false,
	completedLessons,
	buildLessonHref,
	buildEditHref,
	ability,
	abilityStatus,
	isCollapsible = false,
	isCollapsed = false,
	onToggleCollapse,
	withHeader = true,
	showAutoplay = true,
	className,
	wrapperClassName,
	maxHeight = 'h-[calc(100vh-var(--nav-height))]',
	stickyTopClassName = 'top-0',
}: ResourceListViewProps) {
	const scrollAreaRef = useScrollToActive(currentSlug)
	const hasSections = resources?.some((r) => r?.resource?.type === 'section')

	return (
		<nav
			onClick={() => {
				if (isCollapsible && isCollapsed && onToggleCollapse) {
					onToggleCollapse(!isCollapsed)
				}
			}}
			aria-expanded={!isCollapsed}
			aria-controls="workshop-navigation"
			aria-label="Resource navigation"
			className={cn(
				'bg-background relative w-full max-w-xs shrink-0 border-r',
				className,
				{
					'border-r': !isCollapsed,
					'hover:bg-muted/80 w-8 cursor-pointer transition [&_div]:hidden':
						isCollapsed && isCollapsible,
				},
			)}
		>
			<TooltipProvider>
				{isCollapsed && isCollapsible && (
					<span className="sticky top-0 flex items-center justify-center border-b p-2">
						<Tooltip key={String(isCollapsed)}>
							<TooltipTrigger asChild>
								<PanelLeftOpen className="size-4" />
							</TooltipTrigger>
							<TooltipContent side="left">Open navigation</TooltipContent>
						</Tooltip>
					</span>
				)}
				<div
					className={cn(
						'sticky flex flex-col overflow-hidden',
						stickyTopClassName,
						maxHeight,
					)}
				>
					{withHeader && (
						<div className="dark:bg-stripes bg-stripes-muted relative z-10 w-full shrink-0 border-b pl-2">
							{isCollapsible && onToggleCollapse && (
								<Tooltip delayDuration={0}>
									<TooltipTrigger asChild>
										<Button
											className={cn(
												'bg-background text-foreground hover:bg-background absolute right-1.5 top-1.5 z-50 hidden h-8 w-8 border p-1 transition lg:flex',
												{ 'right-0.5': isCollapsed },
											)}
											size="icon"
											type="button"
											onClick={() => onToggleCollapse(!isCollapsed)}
										>
											{isCollapsed ? (
												<PanelLeftOpen className="h-4 w-4" />
											) : (
												<PanelLeftClose className="h-4 w-4" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent className="z-1000" side="left">
										{isCollapsed ? 'Open sidebar' : 'Collapse sidebar'}
									</TooltipContent>
								</Tooltip>
							)}
							<div className="relative z-10 flex w-full flex-row items-center gap-3 px-3 py-4">
								<div className="flex min-w-0 flex-col gap-1.5">
									{breadcrumb && (
										<div className="text-muted-foreground flex items-center gap-1.5 pr-10 text-[12px] leading-none">
											<Link
												href={breadcrumb.href}
												className="hover:text-foreground block truncate transition-colors"
											>
												{breadcrumb.label}
											</Link>
											<span className="text-muted-foreground/50">/</span>
										</div>
									)}
									<Link
										className="font-heading line-clamp-2 text-balance text-[18px] font-semibold leading-[1.2] tracking-[-0.01em] hover:underline xl:text-[20px]"
										href={titleHref}
										title={title}
									>
										{title}
									</Link>
									{showAutoplay && (
										<div className="mt-3">
											<AutoPlayToggle className="text-muted-foreground hover:[&_label]:text-foreground gap-2 text-[12px] transition [&>label]:font-normal [&_button]:scale-90" />
										</div>
									)}
								</div>
							</div>
						</div>
					)}
					<ScrollArea
						className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:!w-full"
						ref={scrollAreaRef}
					>
						<Accordion
							type="single"
							collapsible
							className={cn('flex flex-col', wrapperClassName)}
							defaultValue={
								defaultOpenSectionId || resources?.[0]?.resource?.id
							}
						>
							<ol>
								{resources
									?.filter((r) => r?.resource)
									.map(({ resource, metadata }, i: number) => {
										const childResources =
											resource.resources
												?.map((r: any) => r.resource)
												.filter(Boolean) || []
										const sectionDoneCount =
											resource.type === 'section'
												? childResources.filter((item: any) =>
														completedLessons?.some(
															(p) => p.resourceId === item.id && p.completedAt,
														),
													).length
												: 0
										const isSectionCompleted =
											resource.type === 'section' &&
											childResources.length > 0 &&
											sectionDoneCount === childResources.length

										const canViewSection = ability
											? ability.can(
													'read',
													subject('Content', { id: moduleId }),
												)
											: true

										return resource.type === 'section' ? (
											<li key={`${resource.id}-accordion`}>
												<AccordionItem value={resource.id} className="border-0">
													<AccordionTrigger className="hover:bg-card bg-background group relative flex w-full min-w-0 items-center rounded-none border-b px-4 py-4 text-left text-base leading-tight tracking-tight hover:cursor-pointer hover:no-underline [&>svg]:hidden">
														<div className="flex w-full items-center gap-2.5">
															<ChevronRight
																className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]:rotate-90"
																aria-hidden="true"
																strokeWidth={2}
															/>
															<span
																className="text-muted-foreground/60 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
																aria-hidden="true"
															>
																{String(i + 1).padStart(2, '0')}
															</span>
															<h3 className="font-medium! flex min-w-0 flex-1 items-center gap-1.5 pr-2 text-[14px] leading-tight tracking-[-0.005em]">
																{isSectionCompleted && (
																	<Check
																		className="text-foreground dark:text-primary -ml-0.5 size-3.5 shrink-0"
																		aria-hidden="true"
																		strokeWidth={2.4}
																	/>
																)}
																<span className="truncate">
																	{resource.fields?.title}
																</span>
															</h3>
															{abilityStatus === 'success' && (
																<>
																	{metadata?.tier === 'free' &&
																	!canViewSection ? (
																		<span className="text-muted-foreground border-border inline-flex shrink-0 items-center border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-wider">
																			Free
																		</span>
																	) : !canViewSection ? (
																		<Lock
																			className="text-muted-foreground/60 size-3 shrink-0"
																			aria-label="locked"
																		/>
																	) : null}
																</>
															)}
															{childResources.length > 0 && (
																<span
																	className="text-muted-foreground/70 shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
																	aria-label={`${sectionDoneCount} of ${childResources.length} lessons completed`}
																>
																	{sectionDoneCount}/{childResources.length}
																</span>
															)}
														</div>
													</AccordionTrigger>
													{childResources.length > 0 && (
														<AccordionContent className="pb-0">
															<ol className="bg-background border-b">
																{childResources.map((item: any) => (
																	<LessonResource
																		lesson={item}
																		completedLessons={completedLessons}
																		ability={ability}
																		abilityStatus={abilityStatus}
																		currentSlug={currentSlug}
																		isOnSolution={isOnSolution}
																		buildLessonHref={buildLessonHref}
																		buildEditHref={buildEditHref}
																		indented
																		key={item.id}
																	/>
																))}
															</ol>
														</AccordionContent>
													)}
												</AccordionItem>
											</li>
										) : (
											<LessonResource
												className="border-b"
												lesson={resource}
												completedLessons={completedLessons}
												ability={ability}
												abilityStatus={abilityStatus}
												currentSlug={currentSlug}
												isOnSolution={isOnSolution}
												buildLessonHref={buildLessonHref}
												buildEditHref={buildEditHref}
												indented={hasSections}
												key={resource.id}
											/>
										)
									})}
							</ol>
						</Accordion>
					</ScrollArea>
				</div>
			</TooltipProvider>
		</nav>
	)
}

type LessonResourceProps = {
	lesson: ContentResource
	className?: string
	currentSlug?: string
	isOnSolution?: boolean
	completedLessons?: ModuleProgress['completedLessons']
	ability?: AppAbility
	abilityStatus?: 'error' | 'success' | 'pending'
	buildLessonHref: (slug: string) => string
	buildEditHref?: (slug: string) => string
	indented?: boolean
}

function LessonResource({
	lesson,
	className,
	currentSlug,
	isOnSolution = false,
	completedLessons,
	ability,
	abilityStatus,
	buildLessonHref,
	buildEditHref,
	indented = true,
}: LessonResourceProps) {
	const lessonSlug = lesson.fields?.slug as string
	const childResources = lesson.resources?.map((r) => r.resource) || []
	const solution =
		lesson.type === 'lesson' &&
		childResources.find((resource) => resource.type === 'solution')
	const isActiveSolution = lessonSlug === currentSlug && isOnSolution
	const isActiveLesson = lessonSlug === currentSlug && !isOnSolution
	const isActiveInGroup = isActiveLesson || isActiveSolution
	const showActiveCard = isActiveInGroup && Boolean(solution)

	const isCompleted = completedLessons?.some(
		(p) => p.resourceId === lesson.id && p.completedAt,
	)
	const canViewLesson = ability
		? ability.can('read', subject('Content', { id: lesson.id }))
		: true
	const canCreate = ability ? ability.can('create', 'Content') : false
	const lessonHref = buildLessonHref(lessonSlug)
	const editHref = buildEditHref?.(lessonSlug)

	const lessonGlyph = isCompleted ? (
		<Check
			className="text-foreground dark:text-primary size-3.5"
			aria-hidden="true"
			strokeWidth={2.4}
		/>
	) : (
		<Play className="size-3" aria-hidden="true" strokeWidth={1.8} />
	)

	if (!showActiveCard) {
		const rowClasses = cn(
			'relative flex w-full min-w-0 items-center py-2.5 transition-colors duration-150 ease-out',
			indented ? 'pl-10 pr-12' : 'pl-4 pr-4',
			isActiveLesson &&
				"bg-card dark:bg-foreground/[0.07] before:absolute before:bottom-0 before:left-0 before:top-0 before:w-[2px] before:bg-foreground before:content-[''] dark:before:bg-primary",
			canViewLesson &&
				!isActiveLesson &&
				'hover:bg-card/70 dark:hover:bg-foreground/[0.04]',
		)

		const titleClasses = cn(
			'ml-2.5 min-w-0 flex-1 truncate text-[14px] leading-[1.3] tracking-[-0.005em] transition-colors',
			isActiveLesson
				? 'text-foreground font-semibold dark:text-primary'
				: isCompleted
					? 'text-muted-foreground font-normal'
					: 'text-foreground/85 font-medium',
		)

		const glyphClasses = cn(
			'flex w-3.5 shrink-0 items-center justify-center transition-colors',
			isActiveLesson
				? 'text-foreground dark:text-primary'
				: isCompleted
					? 'text-foreground dark:text-primary'
					: 'text-muted-foreground/70',
		)

		const rowContent = (
			<>
				<span className={glyphClasses}>{lessonGlyph}</span>
				<span className={titleClasses}>{lesson.fields?.title}</span>
				{abilityStatus === 'success' && !canViewLesson && (
					<Lock
						className="text-muted-foreground/60 absolute right-4 size-3"
						aria-label="locked"
					/>
				)}
			</>
		)

		return (
			<li
				key={lesson.id}
				data-active={isActiveLesson ? 'true' : 'false'}
				className={cn('relative', className)}
			>
				<div className="relative flex w-full min-w-0 items-center">
					{canViewLesson ? (
						<Link href={lessonHref} prefetch className={rowClasses}>
							{rowContent}
						</Link>
					) : (
						<div className={rowClasses}>{rowContent}</div>
					)}
					{canCreate && editHref && (
						<Button
							asChild
							variant="outline"
							size="icon"
							className="absolute right-0.5 z-20 scale-75"
						>
							<Link href={editHref}>
								<Pen className="w-3" />
							</Link>
						</Button>
					)}
				</div>
			</li>
		)
	}

	const subRowBase =
		'relative flex w-full min-w-0 items-center py-2 pl-16 pr-10 text-[13px] tracking-[-0.005em] transition-colors'
	const subRowActive = 'bg-foreground/[0.03] dark:bg-foreground/[0.04]'
	const subRowInactive =
		'hover:bg-foreground/[0.02] dark:hover:bg-foreground/[0.03]'

	return (
		<li
			key={lesson.id}
			data-active="true"
			className={cn('relative', className)}
		>
			<span
				aria-hidden="true"
				className="bg-foreground dark:bg-primary absolute inset-y-0 left-0 z-10 w-[2px]"
			/>
			<div className="bg-card dark:bg-foreground/[0.07] relative">
				<div className="relative flex w-full min-w-0 items-center">
					<Link
						href={lessonHref}
						prefetch
						className="relative flex w-full min-w-0 items-center py-2.5 pl-10 pr-12 transition-colors"
					>
						<span
							className={cn(
								'flex w-3.5 shrink-0 items-center justify-center',
								isActiveLesson
									? 'text-foreground dark:text-primary'
									: isCompleted
										? 'text-primary'
										: 'text-muted-foreground/70',
							)}
						>
							{lessonGlyph}
						</span>
						<span
							className={cn(
								'ml-2.5 min-w-0 flex-1 truncate text-[14px] font-semibold leading-[1.3] tracking-[-0.005em]',
								isActiveLesson
									? 'text-foreground dark:text-primary'
									: 'text-foreground/85',
							)}
						>
							{lesson.fields?.title}
						</span>
					</Link>
					{canCreate && editHref && (
						<Button
							asChild
							variant="outline"
							size="icon"
							className="absolute right-0.5 z-20 scale-75"
						>
							<Link href={editHref}>
								<Pen className="w-3" />
							</Link>
						</Button>
					)}
				</div>
				<ul>
					<li data-active={isActiveLesson ? 'true' : 'false'}>
						<Link
							href={lessonHref}
							prefetch
							className={cn(
								subRowBase,
								isActiveLesson ? subRowActive : subRowInactive,
							)}
						>
							<Code2
								className={cn(
									'size-3 shrink-0',
									isActiveLesson
										? 'text-foreground dark:text-primary'
										: 'text-muted-foreground/70',
								)}
								aria-hidden="true"
								strokeWidth={1.8}
							/>
							<span
								className={cn(
									'ml-2.5',
									isActiveLesson
										? 'text-foreground dark:text-primary font-medium'
										: 'text-muted-foreground',
								)}
							>
								Problem
							</span>
						</Link>
					</li>
					<li data-active={isActiveSolution ? 'true' : 'false'}>
						<Link
							href={`${lessonHref}/solution`}
							prefetch
							className={cn(
								subRowBase,
								isActiveSolution ? subRowActive : subRowInactive,
							)}
						>
							<Play
								className={cn(
									'size-3 shrink-0',
									isActiveSolution
										? 'text-foreground dark:text-primary'
										: 'text-muted-foreground/70',
								)}
								aria-hidden="true"
								strokeWidth={1.8}
							/>
							<span
								className={cn(
									'ml-2.5',
									isActiveSolution
										? 'text-foreground dark:text-primary font-medium'
										: 'text-muted-foreground',
								)}
							>
								Solution
							</span>
						</Link>
					</li>
				</ul>
			</div>
		</li>
	)
}
