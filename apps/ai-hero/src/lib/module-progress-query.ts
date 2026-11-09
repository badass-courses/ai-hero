import 'server-only'

import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	resourceProgress,
	users,
} from '@/db/schema'
import { log } from '@/server/logger'
import { eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { ModuleProgress } from '@coursebuilder/core/schemas'

import { summarizeModuleProgressRows } from './module-progress'

const ModuleProgressDbRowSchema = z.object({
	resource_id: z.string(),
	resource_type: z.enum(['lesson', 'exercise', 'post']),
	resource_slug: z.string().nullable(),
	completed_at: z.union([z.string(), z.date()]).nullable(),
	is_optional: z.union([z.string(), z.boolean()]).nullable(),
})

export async function getModuleProgressForIdentity(
	userIdOrEmail: string,
	moduleIdOrSlug: string,
): Promise<ModuleProgress | null> {
	const user = await db.query.users.findFirst({
		where: or(eq(users.id, userIdOrEmail), eq(users.email, userIdOrEmail)),
		columns: { id: true },
	})
	if (!user) return null

	const results = await db.execute(sql`
		WITH RECURSIVE selected_module AS (
			SELECT id
			FROM ${contentResource}
			WHERE id = ${moduleIdOrSlug} OR fields->>'$.slug' = ${moduleIdOrSlug}
		),
		module_structure AS (
			SELECT
				m.id AS module_id,
				crr.position,
				cr.type AS resource_type,
				cr.fields->>'$.slug' AS resource_slug,
				cr.fields->>'$.optional' AS is_optional,
				cr.id AS resource_id
			FROM selected_module m
			JOIN ${contentResourceResource} crr ON m.id = crr.resourceOfId
			JOIN ${contentResource} cr ON crr.resourceId = cr.id
			WHERE crr.deletedAt IS NULL
			AND cr.deletedAt IS NULL
		),
		expanded_resources AS (
			SELECT
				position * 1000 AS global_order,
				resource_id,
				resource_type,
				resource_slug,
				is_optional
			FROM module_structure
			WHERE resource_type IN ('lesson', 'exercise', 'post')
			UNION ALL
			SELECT
				ms.position * 1000 + crr.position AS global_order,
				cr.id AS resource_id,
				cr.type AS resource_type,
				cr.fields->>'$.slug' AS resource_slug,
				cr.fields->>'$.optional' AS is_optional
			FROM module_structure ms
			JOIN ${contentResourceResource} crr ON ms.resource_id = crr.resourceOfId
			JOIN ${contentResource} cr ON crr.resourceId = cr.id
			WHERE ms.resource_type = 'section'
			AND cr.type IN ('lesson', 'exercise', 'post')
			AND crr.deletedAt IS NULL
			AND cr.deletedAt IS NULL
		)
		SELECT
			er.resource_id,
			er.resource_type,
			er.resource_slug,
			er.is_optional,
			rp.completedAt AS completed_at
		FROM expanded_resources er
		LEFT JOIN ${resourceProgress} rp ON rp.resourceId = er.resource_id
			AND rp.userId = ${user.id}
		ORDER BY er.global_order ASC
	`)
	const rawRows = Array.isArray(results) ? results[0] : results.rows
	const parsed = z.array(ModuleProgressDbRowSchema).safeParse(rawRows)
	if (!parsed.success) {
		void log.error('progress.module_rows.parse_failed', {
			moduleIdOrSlug,
			userId: user.id,
			error: parsed.error.message,
		})
		return null
	}

	return summarizeModuleProgressRows(
		user.id,
		parsed.data.map((row) => ({
			resourceId: row.resource_id,
			resourceType: row.resource_type,
			resourceSlug: row.resource_slug,
			completedAt:
				row.completed_at instanceof Date
					? row.completed_at
					: row.completed_at
						? new Date(row.completed_at)
						: null,
			optional: row.is_optional === true || row.is_optional === 'true',
		})),
	)
}
