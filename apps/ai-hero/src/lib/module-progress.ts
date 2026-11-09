import type { ModuleProgress } from '@coursebuilder/core/schemas'

export type ModuleProgressRow = {
	resourceId: string
	resourceType: 'lesson' | 'exercise' | 'post'
	resourceSlug: string | null
	completedAt: Date | null
	optional: boolean
}

export function summarizeModuleProgressRows(
	userId: string,
	rows: readonly ModuleProgressRow[],
): ModuleProgress {
	const completedLessons = rows.flatMap((row) =>
		row.completedAt
			? [{ userId, resourceId: row.resourceId, completedAt: row.completedAt }]
			: [],
	)
	const requiredRows = rows.filter((row) => !row.optional)
	const completedLessonsCount = requiredRows.filter(
		(row) => row.completedAt !== null,
	).length
	const totalLessonsCount = requiredRows.length
	const nextRequiredResource =
		requiredRows.find((row) => row.completedAt === null) ?? null

	return {
		completedLessons,
		nextResource: nextRequiredResource
			? {
					id: nextRequiredResource.resourceId,
					type: nextRequiredResource.resourceType,
					fields: { slug: nextRequiredResource.resourceSlug },
				}
			: null,
		percentCompleted:
			totalLessonsCount > 0
				? Math.ceil((completedLessonsCount / totalLessonsCount) * 100)
				: 0,
		completedLessonsCount,
		totalLessonsCount,
	}
}
