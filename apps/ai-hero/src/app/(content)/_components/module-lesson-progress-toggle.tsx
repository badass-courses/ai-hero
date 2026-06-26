'use client'

import * as React from 'react'
import { useParams } from 'next/navigation'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import type { Lesson } from '@/lib/lessons'
import { setProgressForResource } from '@/lib/progress'

import { Label, Switch } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'
import type { AbilityForResource } from '@coursebuilder/utils/current-ability-rules'

import { revalidateModuleLesson } from '../actions'

export function ModuleLessonProgressToggle({
	lesson,
	moduleType = 'tutorial',
	lessonType,
	abilityLoader,
}: {
	lesson: Lesson
	moduleType?: string
	lessonType?: 'lesson' | 'exercise' | 'solution'
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
}) {
	const params = useParams()
	const ability = React.use(abilityLoader)
	const canView = ability?.canViewLesson

	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()

	const isCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === lesson?.id && p.completedAt,
		),
	)

	const [isPending, startTransition] = React.useTransition()
	const disabled = isPending || !canView
	return lesson ? (
		<>
			<Label
				htmlFor="lesson-progress-toggle"
				className={cn(
					'hover:bg-muted/50 flex h-10 items-center gap-0.5 border-l pl-2 transition hover:cursor-pointer sm:h-12',
				)}
			>
				<Switch
					disabled={disabled}
					className="scale-75 disabled:cursor-auto"
					aria-label={`Mark lesson as ${isCompleted ? 'incomplete' : 'completed'}`}
					id="lesson-progress-toggle"
					checked={isCompleted}
					onCheckedChange={(checked) => {
						// Urgent: update durable progress now so the sidebar flips
						// instantly. (Inside startTransition it would be deferred as
						// non-urgent and lag behind the awaited write.)
						if (checked) {
							addLessonProgress(lesson.id)
						} else {
							removeLessonProgress(lesson.id)
						}
						// Persist in the background; isPending keeps the toggle
						// disabled until the write settles. Revert the durable
						// dispatch if the write fails so the UI can't show a
						// completion (or 100% / certificate unlock) the server
						// never recorded.
						startTransition(async () => {
							try {
								const result = await setProgressForResource({
									resourceId: lesson.id,
									isCompleted: checked,
								})
								// A successful completion returns the saved record; null
								// here means the write failed (an un-complete legitimately
								// returns null, so only revert when we were completing).
								if (checked && result == null) {
									removeLessonProgress(lesson.id)
									return
								}
								await revalidateModuleLesson(
									params.module as string,
									params.lesson as string,
									moduleType,
									lessonType,
								)
							} catch {
								if (checked) {
									removeLessonProgress(lesson.id)
								} else {
									addLessonProgress(lesson.id)
								}
							}
						})
					}}
				/>
				<div className="w-[9ch]">{isCompleted ? 'Completed' : 'Complete'}</div>
			</Label>
		</>
	) : null
}

export function ModuleLessonProgressToggleSkeleton() {
	return (
		<div className="flex animate-pulse items-center gap-2">
			<Label htmlFor="lesson-progress-toggle" className="font-light">
				Mark as complete
			</Label>
			<Switch disabled aria-label="Loading lesson progress" />
		</div>
	)
}
