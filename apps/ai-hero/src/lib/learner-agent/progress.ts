import { db } from '@/db'
import { resourceProgress } from '@/db/schema'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { ProgressPort } from '@ai-hero/learner-agent'

/**
 * The learner's own completion rows, the table `/api/content/progress` and
 * the lesson toggle write. Reads only; scoped to the caller's user id.
 */
export function makeProgressPort(): ProgressPort {
	return {
		completed: async (learner, resourceIds) => {
			if (resourceIds.length === 0) return []
			const rows = await db
				.select({ resourceId: resourceProgress.resourceId })
				.from(resourceProgress)
				.where(
					and(
						eq(resourceProgress.userId, learner.userId),
						inArray(resourceProgress.resourceId, [...resourceIds]),
						isNotNull(resourceProgress.completedAt),
					),
				)
			return rows.flatMap((row) => (row.resourceId ? [row.resourceId] : []))
		},
	}
}
