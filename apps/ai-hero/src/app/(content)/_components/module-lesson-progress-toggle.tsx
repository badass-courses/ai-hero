'use client'

import * as React from 'react'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import type { Lesson } from '@/lib/lessons'
import { setProgressForResource } from '@/lib/progress'
import { motion, useReducedMotion } from 'framer-motion'
import { CheckIcon } from 'lucide-react'

import { Label, Switch } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'
import type { AbilityForResource } from '@coursebuilder/utils/current-ability-rules'

// Same easing as CopyPageButton, so the two icon buttons in the lesson
// controls read as one family.
const easeOutQuint = [0.22, 1, 0.36, 1] as const

export function ModuleLessonProgressToggle({
	lesson,
	abilityLoader,
}: {
	lesson: Lesson
	// Still accepted from callers, but no longer used here: completion writes to
	// durable client state and the DB, and intentionally does NOT revalidate the
	// route (revalidatePath would purge the prefetch Router Cache and slow the
	// next navigation).
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
	const ability = React.use(abilityLoader)
	const canView = ability?.canViewLesson
	const prefersReducedMotion = useReducedMotion()

	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()

	const isCompleted = Boolean(
		moduleProgress?.completedLessons?.some(
			(p) => p.resourceId === lesson?.id && p.completedAt,
		),
	)

	const [isPending, startTransition] = React.useTransition()
	const [popKey, setPopKey] = React.useState(0)
	const disabled = isPending || !canView

	const setCompleted = (checked: boolean) => {
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
				}
			} catch {
				if (checked) {
					removeLessonProgress(lesson.id)
				} else {
					addLessonProgress(lesson.id)
				}
			}
		})
	}

	return lesson ? (
		<>
			{/* Mobile: an icon-sized check button so the lesson controls fit a
			    single row; the switch + label need ~13ch the row doesn't have. */}
			<button
				type="button"
				disabled={disabled}
				aria-pressed={isCompleted}
				aria-label={`Mark lesson as ${isCompleted ? 'incomplete' : 'completed'}`}
				onClick={() => {
					// The pop only plays on an actual completion tap — never on
					// mount (completed lessons load calm) and never on un-complete.
					if (!isCompleted && !prefersReducedMotion) setPopKey((k) => k + 1)
					setCompleted(!isCompleted)
				}}
				className={cn(
					'hover:bg-muted/50 flex h-10 items-center justify-center border-l px-3.5 transition sm:hidden',
					// Completed: the tint defines the cell, and the alpha hairline
					// over the tinted bg reads brighter than the other seams — keep
					// the border box (transparent) so the toggle never shifts 1px.
					isCompleted ? 'bg-primary/10 border-l-transparent' : '',
					disabled ? 'cursor-auto opacity-60' : 'cursor-pointer',
				)}
			>
				{/* Fixed-size box; the icon scales inside it, so no layout shift. */}
				<span className="inline-flex size-4 shrink-0 items-center justify-center">
					<motion.span
						key={popKey}
						initial={false}
						animate={popKey > 0 ? { scale: [1, 1.35, 1] } : { scale: 1 }}
						transition={{
							duration: 0.4,
							times: [0, 0.35, 1],
							ease: easeOutQuint,
						}}
						className="inline-flex items-center justify-center"
					>
						<CheckIcon
							aria-hidden="true"
							className={cn(
								'size-4 transition-colors duration-200',
								isCompleted ? 'text-primary' : 'text-muted-foreground',
							)}
						/>
					</motion.span>
				</span>
			</button>
			<Label
				htmlFor="lesson-progress-toggle"
				className={cn(
					'hover:bg-muted/50 hidden h-10 items-center gap-0.5 border-l pl-2 transition hover:cursor-pointer sm:flex sm:h-12',
				)}
			>
				<Switch
					disabled={disabled}
					className="scale-75 disabled:cursor-auto"
					aria-label={`Mark lesson as ${isCompleted ? 'incomplete' : 'completed'}`}
					id="lesson-progress-toggle"
					checked={isCompleted}
					onCheckedChange={setCompleted}
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
