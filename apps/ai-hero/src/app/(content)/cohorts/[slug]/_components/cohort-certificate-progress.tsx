import type { ModuleProgress } from '@coursebuilder/core/schemas'

import { Certificate } from '../../../_components/cohort-certificate-container'

/**
 * Lessons done and in all, across the cohort's workshops. Nothing if any
 * workshop's progress is missing: a count summed from the ones that answered
 * would understate what the learner has done.
 */
export function cohortLessonCount(progress: (ModuleProgress | null)[] | null) {
	if (!progress || progress.some((workshop) => !workshop)) return {}
	const completedCount = progress.reduce(
		(sum, workshop) => sum + (workshop?.completedLessonsCount ?? 0),
		0,
	)
	const totalCount = progress.reduce(
		(sum, workshop) => sum + (workshop?.totalLessonsCount ?? 0),
		0,
	)
	return totalCount > 0 ? { completedCount, totalCount } : {}
}

/**
 * The owner's certificate tile with its lesson count. The count is the sum of
 * the per-workshop progress the rail's rows already load, so it costs no read
 * of its own. It waits on those reads, so the page renders it inside a
 * Suspense boundary and shows the uncounted tile until they land.
 */
export async function CohortCertificateProgress({
	workshopProgressMap,
	resourceSlugOrId,
	isCompleted,
}: {
	workshopProgressMap: Map<string, Promise<ModuleProgress | null>>
	resourceSlugOrId: string
	isCompleted: boolean
}) {
	const progress = await Promise.all(workshopProgressMap.values()).catch(
		() => null,
	)

	return (
		<Certificate
			resourceSlugOrId={resourceSlugOrId}
			isCompleted={isCompleted}
			{...cohortLessonCount(progress)}
		/>
	)
}
