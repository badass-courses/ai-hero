import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	resourceProgress,
} from '@/db/schema'
import { log } from '@/server/logger'
import { sql } from 'drizzle-orm'

import { getAllWorkshopsInCohort } from './cohorts-query'
import type { Workshop } from './workshops'

export async function checkCertificateEligibility(
	resourceId: string,
	userId: string,
) {
	if (!userId) {
		return { hasCompletedModule: false }
	}

	const { completed: hasCompletedModule, lastCompletedDate } =
		await hasUserCompletedAllLessons(userId, resourceId)

	return { hasCompletedModule, date: lastCompletedDate }
}

export async function checkCohortCertificateEligibilityFromWorkshops(
	workshops: Workshop[],
	userId?: string,
) {
	if (!userId) {
		return { hasCompletedCohort: false, date: null }
	}

	if (!workshops || workshops.length === 0) {
		return { hasCompletedCohort: false, date: null }
	}

	const moduleCompletionPromises = workshops.map((module) =>
		hasUserCompletedAllLessons(userId, module.id),
	)

	const moduleCompletionResults = await Promise.all(moduleCompletionPromises)
	const allModulesCompleted = moduleCompletionResults.every(
		(result) => result.completed,
	)

	if (!allModulesCompleted) {
		return { hasCompletedCohort: false, date: null }
	}

	const completionDates = moduleCompletionResults
		.map((result) => result.lastCompletedDate)
		.filter((date): date is Date => date !== null)

	let latestCompletionDate: Date | null = null
	if (completionDates.length > 0) {
		latestCompletionDate = new Date(
			Math.max(...completionDates.map((date) => date.getTime())),
		)
	}

	return {
		hasCompletedCohort: allModulesCompleted,
		date: latestCompletionDate,
	}
}

export async function checkCohortCertificateEligibility(
	cohortId: string,
	userId?: string,
) {
	if (!userId) {
		return { hasCompletedCohort: false, date: null }
	}
	try {
		const modules = await getAllWorkshopsInCohort(cohortId)

		if (!modules || modules.length === 0) {
			return { hasCompletedCohort: false, date: null }
		}

		const moduleCompletionPromises = modules.map((module) =>
			hasUserCompletedAllLessons(userId, module.id),
		)

		const moduleCompletionResults = await Promise.all(moduleCompletionPromises)
		const allModulesCompleted = moduleCompletionResults.every(
			(result) => result.completed,
		)

		if (!allModulesCompleted) {
			return { hasCompletedCohort: false, date: null }
		}

		const completionDates = moduleCompletionResults
			.map((result) => result.lastCompletedDate)
			.filter((date): date is Date => date !== null)

		let latestCompletionDate: Date | null = null
		if (completionDates.length > 0) {
			latestCompletionDate = new Date(
				Math.max(...completionDates.map((date) => date.getTime())),
			)
		}

		return {
			hasCompletedCohort: allModulesCompleted,
			date: latestCompletionDate,
		}
	} catch (error) {
		void log.error('certificate.query.error', {
			cohortId,
			userId,
			error: error instanceof Error ? error.message : String(error),
		})
		return { hasCompletedCohort: false, date: null }
	}
}

/**
 * Has the learner finished every lesson the module holds today?
 *
 * "Holds today" is the point. Removing a lesson from a module soft-deletes
 * the link row (course sync does it when a course is restructured), and a
 * lesson that is no longer in the module is not something anyone can finish.
 * So a soft-deleted link, or a soft-deleted resource, is not required. This
 * is the same rule the lesson lists use, which keeps what a learner is asked
 * to complete equal to what they can see.
 *
 * A module with nothing to complete is not complete: an emptied module must
 * not hand out its certificate.
 */
async function hasUserCompletedAllLessons(
	userId: string,
	resourceId: string,
): Promise<{ completed: boolean; lastCompletedDate: Date | null }> {
	// Execute the optimized query to check if there are any incomplete lessons
	const results: any = await db.execute(sql`
	SELECT
		COUNT(DISTINCT cr.id) AS required_lessons,
		COUNT(CASE WHEN rp.completedAt IS NULL THEN 1 END) AS incomplete_lessons,
		MAX(rp.completedAt) AS last_completed_date
	FROM ${contentResource} cr
	LEFT JOIN ${resourceProgress} rp ON rp.resourceId = cr.id AND rp.userId = ${userId}
	WHERE cr.id IN (
			SELECT cr.id
			FROM ${contentResource} cr
			WHERE cr.id IN (
					SELECT crr.resourceId
					FROM ${contentResourceResource} crr
					WHERE crr.resourceOfId = (
							SELECT id
							FROM ${contentResource}
							WHERE id = ${resourceId} OR fields->>'$.slug' = ${resourceId}
					)
					AND crr.deletedAt IS NULL
			)
			OR cr.id IN (
					SELECT crr.resourceId
					FROM ${contentResourceResource} crr
					WHERE crr.deletedAt IS NULL
					AND crr.resourceOfId IN (
							SELECT crr.resourceId
							FROM ${contentResourceResource} crr
							JOIN ${contentResource} parent ON parent.id = crr.resourceId
							WHERE crr.resourceOfId = (
									SELECT id
									FROM ${contentResource}
									WHERE id = ${resourceId} OR fields->>'$.slug' = ${resourceId}
							)
							AND crr.deletedAt IS NULL
							AND parent.deletedAt IS NULL
					)
			)
	)
	AND cr.type IN ('lesson', 'exercise')
	AND cr.deletedAt IS NULL
	AND (cr.fields->>'$.optional' IS NULL OR cr.fields->>'$.optional' = 'false')
`)

	const requiredLessons = Number(results.rows[0]?.required_lessons) || 0
	const incompleteLessons = Number(results.rows[0]?.incomplete_lessons) || 0
	const lastCompletedDate = results.rows[0]?.last_completed_date
		? new Date(results.rows[0].last_completed_date)
		: null

	const completed = requiredLessons > 0 && incompleteLessons === 0

	return { completed, lastCompletedDate }
}
