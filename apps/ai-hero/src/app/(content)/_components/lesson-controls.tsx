'use server'

import React, { use } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import type { Lesson } from '@/lib/lessons'
import { getServerAuthSession } from '@/server/auth'
import { CK_SUBSCRIBER_KEY } from '@skillrecordings/config'
import { ArrowRight, Github } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'
import type { AbilityForResource } from '@coursebuilder/utils/current-ability-rules'

import { CopyProblemPromptButton } from '../workshops/_components/copy-problem-prompt-button'
import GetAccessButton from '../workshops/_components/get-access-button'
import { NextLessonToolbarButton } from '../workshops/_components/next-lesson-toolbar-button'
import { AutoPlayToggle } from './autoplay-toggle'
import { CopyPageButton } from './copy-page-button'
import { ModuleLessonProgressToggle } from './module-lesson-progress-toggle'

export const LessonControls = async ({
	lesson,
	problem,
	className,
	moduleType = 'workshop',
	abilityLoader,
	moduleSlug,
}: {
	lesson: Lesson | null
	problem?: Lesson | null
	className?: string
	moduleType?: 'tutorial' | 'workshop'
	moduleSlug: string
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
}) => {
	const { session } = await getServerAuthSession()
	const cookieStore = await cookies()
	const ckSubscriber = cookieStore.has(CK_SUBSCRIBER_KEY)

	if (!lesson) {
		return null
	}
	const githubUrl = lesson.fields?.github || problem?.fields?.github
	const markdownToCopy = lesson.fields?.body
		? `# ${lesson.fields?.title}\n\n${lesson.fields.body}`
		: null

	const hasSolution = lesson.resources?.some(
		(resource) => resource.resource.type === 'solution',
	)

	const isProblemLesson = lesson.type === 'lesson' && hasSolution

	return (
		<div
			className={cn(
				'bg-card mb-8 flex w-full flex-col items-stretch border-b sm:flex-row sm:items-center sm:justify-between',
				className,
			)}
		>
			<div className="flex grow items-center">
				<React.Suspense fallback={null}>
					<GetAccessButton
						className="border-r-border bg-primary dark:hover:bg-primary/90 h-10 rounded-none border-0 border-r px-5 text-sm sm:h-12"
						abilityLoader={abilityLoader}
						moduleSlug={moduleSlug}
					/>
				</React.Suspense>
				<React.Suspense fallback={null}>
					<CopyProblemPromptButton
						abilityLoader={abilityLoader}
						lesson={lesson}
						problem={problem}
						className="hover:bg-muted/50 border-r-border h-10 rounded-none border-0 border-r bg-transparent px-3 text-sm sm:h-12"
					/>
				</React.Suspense>
				{githubUrl && (
					<Button
						asChild
						variant="outline"
						className="hover:bg-muted/50 border-r-border h-10 rounded-none border-0 bg-transparent sm:h-12 sm:border-r"
					>
						<Link href={githubUrl} target="_blank">
							<Github className="text-muted-foreground size-4" />
							<span className="inline-block sm:hidden" aria-hidden="true">
								Code
							</span>
							<span className="hidden sm:inline-block">Source Code</span>
						</Link>
					</Button>
				)}
				{markdownToCopy && (
					<CopyPageButton
						markdown={markdownToCopy}
						className="hover:bg-muted/50 border-r-border h-10 rounded-none border-0 border-r bg-transparent px-3 text-sm sm:h-12"
					/>
				)}
			</div>
			<div className="flex items-center justify-end border-t empty:hidden sm:border-t-0 [&>*:first-child]:border-l-0 sm:[&>*:first-child]:border-l">
				{isProblemLesson && (
					<Button
						asChild
						variant="outline"
						className="hover:bg-muted/50 border-l-border h-10 rounded-none border-0 border-l bg-transparent sm:h-12"
					>
						<Link href={`${lesson.fields.slug}/solution`} prefetch>
							Solution
							<ArrowRight className="text-muted-foreground ml-2 h-4 w-4" />
						</Link>
					</Button>
				)}
				<React.Suspense fallback={null}>
					{(session?.user || ckSubscriber) &&
					((lesson.type === 'lesson' && !isProblemLesson) ||
						lesson.type === 'solution') ? (
						<ModuleLessonProgressToggle
							abilityLoader={abilityLoader}
							// if we are on solution, pass in exercise as lesson for completing
							lesson={lesson.type === 'solution' && problem ? problem : lesson}
							moduleType={moduleType}
							lessonType={
								lesson.type === 'solution' && problem ? 'solution' : lesson.type
							}
						/>
					) : null}
				</React.Suspense>
				{!isProblemLesson && (
					<NextLessonToolbarButton
						lessonId={lesson.id}
						moduleSlug={moduleSlug}
					/>
				)}
			</div>
		</div>
	)
}
