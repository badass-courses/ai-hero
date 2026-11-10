import { courseBuilderAdapter, db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { sql } from 'drizzle-orm'

import {
	countRequiredModuleProgress,
	type RequiredModuleProgress,
} from './required-module-progress'

/** App-owned projection; the shared adapter still records all lesson completions. */
export async function getRequiredModuleProgressForUser(
	userIdOrEmail: string,
	moduleIdOrSlug: string,
): Promise<RequiredModuleProgress | null> {
	const progress = await courseBuilderAdapter.getModuleProgressForUser(
		userIdOrEmail,
		moduleIdOrSlug,
	)
	if (!progress) return null
	// Match the adapter's direct lessons/posts and one-level section expansion,
	// including its live-edge/resource checks and order.
	const result: any = await db.execute(sql`
		WITH workshop AS (
			SELECT id FROM ${contentResource}
			WHERE id = ${moduleIdOrSlug} OR fields->>'$.slug' = ${moduleIdOrSlug}
		), structure AS (
			SELECT cr.id, cr.type, cr.fields, crr.position
			FROM workshop w
			JOIN ${contentResourceResource} crr ON crr.resourceOfId = w.id
			JOIN ${contentResource} cr ON cr.id = crr.resourceId
			WHERE crr.deletedAt IS NULL AND cr.deletedAt IS NULL
		), lessons AS (
			SELECT id, type, fields, position * 1000 AS global_order
			FROM structure WHERE type IN ('lesson', 'post')
			UNION ALL
			SELECT cr.id, cr.type, cr.fields, s.position * 1000 + crr.position AS global_order
			FROM structure s
			JOIN ${contentResourceResource} crr ON crr.resourceOfId = s.id
			JOIN ${contentResource} cr ON cr.id = crr.resourceId
			WHERE s.type = 'section' AND cr.type IN ('lesson', 'post')
			AND crr.deletedAt IS NULL AND cr.deletedAt IS NULL
		)
		SELECT id, type, fields->>'$.slug' AS slug, fields->>'$.optional' AS optional
		FROM lessons ORDER BY global_order
	`)
	const rows = Array.isArray(result) ? result[0] : result.rows
	return countRequiredModuleProgress(
		progress,
		rows.map((row: any) => ({
			id: row.id,
			type: row.type,
			slug: row.slug,
			optional: row.optional === 'true' || row.optional === true,
		})),
	)
}
