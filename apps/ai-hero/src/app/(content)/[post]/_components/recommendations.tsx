'use client'

import { setProgressForResource } from '@/lib/progress'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import { PostUpNextCard } from '../../_components/post-up-next-card'
import { useProgress } from './progress-provider'

export default function Recommendations({
	postId,
	className,
	documentIdsToSkip,
	hideLoginPrompt,
}: {
	postId: string
	className?: string
	documentIdsToSkip?: string[]
	hideLoginPrompt?: boolean
}) {
	const { data: post, status } = api.typesense.getNearestNeighbor.useQuery(
		{
			documentId: postId,
			documentIdsToSkip,
		},
		{
			refetchOnWindowFocus: false,
		},
	)
	const { progress, addLessonProgress } = useProgress()
	const { data: session } = useSession()
	const isCompleted = progress?.completedLessons.some(
		(lesson) => lesson.resourceId === postId,
	)

	if (!post && status !== 'pending') return null

	if (post) {
		return (
			<PostUpNextCard
				ariaLabel="Recommendations"
				title={post.title}
				href={`/${post.slug}`}
				showLoginPrompt={!hideLoginPrompt && !session?.user}
				className={className}
				onClick={async () => {
					if (!isCompleted) {
						addLessonProgress(postId)
						await setProgressForResource({
							resourceId: postId,
							isCompleted: true,
						})
					}
				}}
			/>
		)
	}

	return (
		<nav
			className={cn(
				'bg-card flex w-full flex-col items-center border-y py-16 text-center',
				className,
			)}
			aria-label="Recommendations"
		>
			<h2 className="mb-3 px-5 text-xl font-semibold sm:text-3xl">Up Next</h2>
			<ul className="w-full">
				<li className="flex w-full flex-col px-5">
					<Skeleton className="mx-auto mt-2 flex h-8 w-full max-w-sm" />
				</li>
			</ul>
		</nav>
	)
}
