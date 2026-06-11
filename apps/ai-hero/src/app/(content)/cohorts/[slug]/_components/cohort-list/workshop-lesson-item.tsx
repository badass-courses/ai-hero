'use client'

import Link from 'next/link'
import { type AppAbility } from '@/ability'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import { subject } from '@casl/ability'
import { Check, Lock, Play } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

type LessonResource = {
	id: string
	type: string
	fields?: { slug?: string; title?: string } | null
}

export function WorkshopLessonItem({
	resource,
	workshopSlug,
	className,
	ability,
	abilityStatus,
}: {
	resource: LessonResource
	workshopSlug: string
	className?: string
	ability: AppAbility
	abilityStatus: 'error' | 'success' | 'pending'
}) {
	const { moduleProgress } = useModuleProgress()
	const isLessonCompleted = moduleProgress?.completedLessons.some(
		(lesson) => lesson.resourceId === resource.id && lesson.completedAt,
	)
	const canViewLesson = ability.can(
		'read',
		subject('Content', { id: resource.id }),
	)

	const glyph = isLessonCompleted ? (
		<Check
			className="text-foreground dark:text-primary size-3.5"
			aria-hidden="true"
			strokeWidth={2.4}
		/>
	) : (
		<Play className="size-3" aria-hidden="true" strokeWidth={1.8} />
	)

	const rowClasses = cn(
		'relative flex w-full min-w-0 items-center py-2.5 pl-10 pr-10 transition-colors duration-150 ease-out',
		canViewLesson && 'hover:bg-card/70 dark:hover:bg-foreground/[0.04]',
		className,
	)

	const glyphClasses = cn(
		'flex w-3.5 shrink-0 items-center justify-center transition-colors',
		isLessonCompleted
			? 'text-foreground dark:text-primary'
			: 'text-muted-foreground/70',
	)

	const titleClasses = cn(
		'ml-2.5 min-w-0 flex-1 truncate text-[14px] leading-[1.3] tracking-[-0.005em] transition-colors',
		canViewLesson
			? isLessonCompleted
				? 'text-muted-foreground font-normal'
				: 'text-foreground/85 font-medium'
			: 'text-foreground/50 font-normal',
	)

	const rowContent = (
		<>
			<span className={glyphClasses}>{glyph}</span>
			<span className={titleClasses}>{resource?.fields?.title}</span>
			{abilityStatus === 'success' && !canViewLesson && (
				<Lock
					className="text-muted-foreground/60 absolute right-4 size-3"
					aria-label="locked"
				/>
			)}
		</>
	)

	return (
		<li key={resource?.id} className="relative w-full">
			{canViewLesson ? (
				<Link
					className={rowClasses}
					href={getResourcePath(
						resource.type,
						resource.fields?.slug ?? '',
						'view',
						{
							parentSlug: workshopSlug,
							parentType: 'workshop',
						},
					)}
				>
					{rowContent}
				</Link>
			) : (
				<div className={rowClasses}>{rowContent}</div>
			)}
		</li>
	)
}
