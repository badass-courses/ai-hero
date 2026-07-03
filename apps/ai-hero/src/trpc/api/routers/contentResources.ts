import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { getAllWorkshopsInCohort } from '@/lib/cohorts-query'
import { getList } from '@/lib/lists-query'
import { ListResourcesForPickerInputSchema } from '@/lib/resources'
import {
	getResourceParents,
	listResourcesForPicker,
} from '@/lib/resources-query'
import { getWorkshop } from '@/lib/workshops-query'
import { getServerAuthSession } from '@/server/auth'
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from '@/trpc/api/trpc'
import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'

export const contentResourceRouter = createTRPCRouter({
	getList: publicProcedure
		.input(
			z.object({
				slugOrId: z.string(),
			}),
		)
		.query(async ({ input }) => {
			return await getList(input.slugOrId)
		}),
	getAll: protectedProcedure
		.input(
			z
				.object({
					contentTypes: z
						.array(z.string())
						.default(['event', 'lesson', 'tutorial', 'workshop']),
				})
				.default({ contentTypes: ['event', 'lesson', 'tutorial', 'workshop'] }),
		)
		.query(async ({ input }) => {
			const { session, ability } = await getServerAuthSession()
			if (!session?.user || !ability.can('create', 'Content')) {
				throw new Error('Unauthorized')
			}
			return db.query.contentResource.findMany({
				where: inArray(contentResource.type, input.contentTypes),
				with: {
					resources: true,
				},
			})
		}),
	getPublishedResourcesLength: publicProcedure.query(async () => {
		const result = await db.execute(sql`
				SELECT
					type,
					COUNT(*) as count
				FROM ${contentResource}
				WHERE type IN ('post', 'list')
				AND JSON_EXTRACT(fields, '$.state') = 'published'
				GROUP BY type
			`)

		const total = (result.rows as any[]).reduce(
			(sum, row) => sum + Number(row.count),
			0,
		)
		return total
	}),
	/**
	 * Recent-first, DB-backed rows for the editor's ResourcePicker
	 * (ORDER BY updatedAt DESC; optional title LIKE search). Ability
	 * gating (create Content) happens inside `listResourcesForPicker`.
	 */
	listForPicker: protectedProcedure
		.input(ListResourcesForPickerInputSchema)
		.query(async ({ input }) => {
			return await listResourcesForPicker(input)
		}),
	/**
	 * One-level reverse lookup (lists/workshops/cohorts via
	 * ContentResourceResource + products via ContentResourceProduct) —
	 * powers the "Part of" strip. Gated (update Content) inside
	 * `getResourceParents`.
	 */
	getParents: protectedProcedure
		.input(z.object({ resourceId: z.string() }))
		.query(async ({ input }) => {
			return await getResourceParents(input.resourceId)
		}),
	getWorkshop: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ input }) => {
			return await getWorkshop(input.id)
		}),
	getNextWorkshopInCohort: publicProcedure
		.input(
			z.object({
				cohortId: z.string(),
				currentWorkshopId: z.string(),
			}),
		)
		.query(async ({ input }) => {
			const workshops = await getAllWorkshopsInCohort(input.cohortId)
			const currentIndex = workshops.findIndex(
				(w) => w.id === input.currentWorkshopId,
			)
			if (currentIndex === -1 || currentIndex === workshops.length - 1) {
				return null
			}
			return workshops[currentIndex + 1] ?? null
		}),
})
