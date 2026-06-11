'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { setProgressForResource } from '@/lib/progress'
import { getNextUpResourceFromList } from '@/utils/get-nextup-resource-from-list'
import { useSession } from 'next-auth/react'

import { useList } from '../[post]/_components/list-provider'
import { useProgress } from '../[post]/_components/progress-provider'
import Recommendations from '../[post]/_components/recommendations'
import { PostUpNextCard } from './post-up-next-card'

export default function PostNextUpFromListPagination({
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
	const router = useRouter()
	const { list } = useList()
	const nextUp = list && getNextUpResourceFromList(list, postId)
	const { progress, addLessonProgress } = useProgress()
	const isCompleted = progress?.completedLessons.some(
		(lesson) => lesson.resourceId === postId,
	)
	const { data: session } = useSession()

	React.useEffect(() => {
		if (nextUp) {
			router.prefetch(`/${nextUp.resource.fields?.slug}`)
		}
	}, [nextUp, list, router])

	if (!nextUp)
		return (
			<Recommendations
				postId={postId}
				className={className}
				documentIdsToSkip={documentIdsToSkip}
				hideLoginPrompt={hideLoginPrompt}
			/>
		)

	return nextUp?.resource && nextUp?.resource?.fields?.state === 'published' ? (
		<PostUpNextCard
			ariaLabel="List navigation"
			title={nextUp.resource.fields?.title ?? 'Continue'}
			href={`/${nextUp.resource.fields?.slug}`}
			showLoginPrompt={!hideLoginPrompt && !session?.user}
			surfaceClassName="dark:bg-card bg-background"
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
	) : null
}
