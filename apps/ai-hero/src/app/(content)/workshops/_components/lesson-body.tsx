'use client'

import { use } from 'react'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import type { Lesson } from '@/lib/lessons'
import { LESSON_DENIAL_COPY, lessonDenialReason } from '@/lib/lesson-denial'
import { MinimalWorkshop } from '@/lib/workshops'
import { formatInTimeZone } from 'date-fns-tz'
import { Lock } from 'lucide-react'

import type { AbilityForResource } from '@coursebuilder/utils/current-ability-rules'

export function LessonBody({
	lesson,
	workshop,
	abilityLoader,
	mdxContentPromise,
	signedIn = false,
}: {
	lesson: Lesson | null
	workshop: MinimalWorkshop | null
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
	mdxContentPromise: Promise<{ content: React.ReactNode }>
	signedIn?: boolean
}) {
	const ability = use(abilityLoader)
	const canView = ability?.canViewLesson

	if (!canView) {
		const reason = lessonDenialReason({
			signedIn,
			isRegionRestricted: ability.isRegionRestricted,
			isPendingOpenAccess: ability.isPendingOpenAccess,
			hasTeamPool: ability.canInviteTeam,
		})
		const message =
			reason !== 'pending-open'
				? LESSON_DENIAL_COPY[reason]
				: workshop?.fields?.startsAt
					? `This lesson is not available yet. Please check back on ${formatInTimeZone(
							new Date(workshop.fields.startsAt),
							workshop?.fields?.timezone || 'America/Los_Angeles',
							`MMM d, yyyy 'at' h:mm a z`,
						)}`
					: 'This lesson is not available yet.'
		return (
			<div
				className={`prose dark:prose-invert prose-a:text-primary lg:prose-lg ${PROSE_MEASURE}`}
			>
				<p>
					<Lock className="mr-1 inline-block size-5 opacity-75" /> {message}
				</p>
			</div>
		)
	}

	const { content } = use(mdxContentPromise)

	return (
		<div
			className={`prose-img:rounded-lg dark:prose-invert prose prose-a:text-primary lg:prose-pre:text-sm lg:prose-pre:leading-relaxed lg:prose-lg ${PROSE_MEASURE}`}
		>
			{content}
		</div>
	)
}
