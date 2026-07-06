'use server'

import { revalidateTag, unstable_cache } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceVersion as contentResourceVersionTable,
} from '@/db/schema'
import { env } from '@/env.mjs'
import { generateContentHash } from '@/lib/post-utils'
import {
	NewSolutionInputSchema,
	Solution,
	SolutionSchema,
	type NewSolutionInput,
	type SolutionUpdate,
} from '@/lib/solution'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { guid } from '@coursebuilder/utils/guid'
import slugify from '@sindresorhus/slugify'
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas'
import { VideoResourceSchema } from '@coursebuilder/core/schemas/video-resource'

import { deletePostInTypeSense, upsertPostToTypeSense } from './typesense-query'

/**
 * Get a solution for a specific lesson (returns first one found)
 */
export async function getSolutionForLesson(lessonId: string) {
	log.info('solution.getForLesson', { lessonId })

	// Use a direct SQL query to get the solution linked to the lesson
	const query = sql`
		SELECT s.*
		FROM ${contentResource} AS s
		JOIN ${contentResourceResource} AS crr ON s.id = crr.resourceId
		WHERE crr.resourceOfId = ${lessonId}
		  AND s.type = 'solution'
		  AND s.deletedAt IS NULL
		  AND crr.deletedAt IS NULL
		LIMIT 1;
	`

	try {
		const result = await db.execute(query)

		if (!result.rows.length) {
			log.error('solution.getForLesson.error', {
				lessonId,
				error: 'No solution found',
			})
			return null
		}

		// Get the full solution with its resources
		// Type assertion to handle the SQL result properly
		const solutionId = (result.rows[0] as { id: string }).id

		const solution = await db.query.contentResource.findFirst({
			where: and(
				eq(contentResource.id, solutionId),
				isNull(contentResource.deletedAt),
			),
			with: {
				resources: {
					where: isNull(contentResourceResource.deletedAt),
					with: {
						resource: true,
					},
				},
			},
		})

		const parsedSolution = SolutionSchema.safeParse(solution)

		if (!parsedSolution.success) {
			log.error('solution.getForLesson.error', {
				lessonId,
				error: parsedSolution.error,
			})
			return null
		}

		return parsedSolution.data
	} catch (error) {
		log.error('solution.getForLesson.error', {
			error,
			lessonId,
		})
		return null
	}
}

/**
 * Get ALL solutions for a specific lesson
 */
export async function getAllSolutionsForLesson(lessonId: string) {
	log.info('solution.getAllForLesson', { lessonId })

	const query = sql`
		SELECT s.*
		FROM ${contentResource} AS s
		JOIN ${contentResourceResource} AS crr ON s.id = crr.resourceId
		WHERE crr.resourceOfId = ${lessonId}
		  AND s.type = 'solution'
		  AND s.deletedAt IS NULL
		  AND crr.deletedAt IS NULL
		ORDER BY crr.position ASC, s.createdAt ASC;
	`

	try {
		const result = await db.execute(query)

		if (!result.rows.length) {
			return []
		}

		const solutions = []
		for (const row of result.rows) {
			const solutionId = (row as { id: string }).id

			const solution = await db.query.contentResource.findFirst({
				where: and(
					eq(contentResource.id, solutionId),
					isNull(contentResource.deletedAt),
				),
				with: {
					resources: {
						where: isNull(contentResourceResource.deletedAt),
						with: {
							resource: true,
						},
					},
				},
			})

			const parsedSolution = SolutionSchema.safeParse(solution)
			if (parsedSolution.success) {
				solutions.push(parsedSolution.data)
			}
		}

		return solutions
	} catch (error) {
		log.error('solution.getAllForLesson.error', {
			error,
			lessonId,
		})
		return []
	}
}

export const getCachedSolution = unstable_cache(
	async (slug: string) => getSolution(slug),
	['solution'],
	{ revalidate: 3600, tags: ['solution'] },
)
/**
 * Get solution by ID or slug
 */
export async function getSolution(solutionSlugOrId: string) {
	const cachedSolution = await redis.get(
		`solution:${env.NEXT_PUBLIC_APP_NAME}:${solutionSlugOrId}`,
	)

	const solution = cachedSolution
		? cachedSolution
		: await db.query.contentResource.findFirst({
				where: and(
					or(
						eq(
							sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
							solutionSlugOrId,
						),
						eq(contentResource.id, solutionSlugOrId),
					),
					eq(contentResource.type, 'solution'),
					isNull(contentResource.deletedAt),
				),
				with: {
					resources: {
						with: {
							resource: {
								columns: {
									type: true,
								},
							},
						},
					},
				},
			})

	if (!solution) {
		return null
	}

	const parsedSolution = SolutionSchema.safeParse(solution)
	if (!parsedSolution.success) {
		log.error('solution.parse.error', {
			error: parsedSolution.error,
			solutionId: solutionSlugOrId,
		})
		return null
	}

	if (!cachedSolution) {
		await redis.set(
			`solution:${env.NEXT_PUBLIC_APP_NAME}:${solutionSlugOrId}`,
			solution,
			{ ex: 10 },
		)
	}

	return parsedSolution.data
}

/**
 * Create a new solution for a lesson
 */
export async function createSolution({
	lessonId,
	title,
	body,
	slug,
	description,
}: {
	lessonId: string
	title: string
	body?: string
	slug: string
	description?: string
}) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	try {
		// Create the solution resource with required fields
		const solution = await courseBuilderAdapter.createContentResource({
			type: 'solution',
			fields: {
				title,
				body: body || '',
				slug,
				description: description || '',
				state: 'draft',
				visibility: 'unlisted',
			},
			createdById: user.id,
		} as any)

		// Create the link between lesson and solution
		await db.insert(contentResourceResource).values({
			resourceId: solution.id,
			resourceOfId: lessonId,
			position: 0,
		})

		log.info('solution.created', {
			solutionId: solution.id,
			lessonId,
			userId: user.id,
		})

		try {
			await upsertPostToTypeSense(solution, 'save')
			await log.info('solution.typesense.indexed', {
				solutionId: solution.id,
				action: 'save',
			})
		} catch (error) {
			await log.error('solution.typesense.index.failed', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				solutionId: solution.id,
			})
		}

		revalidateTag('solution', 'max')
		revalidateTag('workshop-navigation', 'max')
		return solution
	} catch (error) {
		log.error('solution.create.error', {
			error,
			lessonId,
			userId: user.id,
		})
		throw error
	}
}

/**
 * Update an existing solution
 */
export async function updateSolution(input: Partial<Solution>) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	// Ensure we have an ID to look up
	const id = input.id
	if (!id) {
		throw new Error('Solution ID is required for updates')
	}

	const currentSolution = await getSolution(id)

	if (!currentSolution) {
		throw new Error(`Solution with id ${id} not found.`)
	}

	let solutionSlug = currentSolution.fields.slug

	// Slugs are intentionally NOT regenerated when the title changes — only an
	// explicit edit to the slug field changes the slug.
	if (input.fields?.slug && input.fields.slug !== currentSolution.fields.slug) {
		solutionSlug = input.fields.slug
	}

	try {
		const updatedResource =
			await courseBuilderAdapter.updateContentResourceFields({
				id: currentSolution.id,
				fields: {
					...currentSolution.fields,
					...input.fields,
					slug: solutionSlug,
				},
			})

		try {
			await upsertPostToTypeSense(
				{
					...currentSolution,
					fields: {
						...currentSolution.fields,
						...input.fields,
						slug: solutionSlug,
					},
				},
				'save',
			)
			await log.info('solution.update.typesense.success', {
				solutionId: currentSolution.id,
				userId: user.id,
			})
		} catch (error) {
			await log.error('solution.update.typesense.failed', {
				solutionId: currentSolution.id,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				userId: user.id,
			})
		}

		log.info('solution.updated', {
			solutionId: currentSolution.id,
			userId: user.id,
		})

		revalidateTag('solution', 'max')
		revalidateTag('workshop-navigation', 'max')
		return updatedResource
	} catch (error) {
		log.error('solution.update.error', {
			error,
			solutionId: currentSolution.id,
			userId: user.id,
		})
		throw error
	}
}

/**
 * Delete a solution (hard delete - removes entirely from database)
 */
export async function deleteSolution(solutionId: string) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('delete', 'Content')) {
		throw new Error('Unauthorized')
	}

	try {
		// Find the resource join first to get the lesson ID for logging
		const resourceJoin = await db.query.contentResourceResource.findFirst({
			where: eq(contentResourceResource.resourceId, solutionId),
		})

		const lessonId = resourceJoin?.resourceOfId

		// Hard delete the resource join
		await db
			.delete(contentResourceResource)
			.where(eq(contentResourceResource.resourceId, solutionId))

		// Hard delete the solution
		await db.delete(contentResource).where(eq(contentResource.id, solutionId))

		try {
			await deletePostInTypeSense(solutionId)
			await log.info('solution.delete.typesense.success', { solutionId })
		} catch (error) {
			await log.error('solution.delete.typesense.failed', {
				solutionId,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			})
		}

		log.info('solution.deleted', {
			solutionId,
			lessonId,
			userId: user.id,
		})

		revalidateTag('solution', 'max')
		revalidateTag('workshop-navigation', 'max')
		return { success: true }
	} catch (error) {
		log.error('solution.delete.error', {
			error,
			solutionId,
			userId: user.id,
		})
		throw error
	}
}

/**
 * Get the parent lesson for a solution
 */
export async function getLessonForSolution(solutionId: string) {
	try {
		// Find the resource join that links this solution to its lesson
		const resourceJoin = await db.query.contentResourceResource.findFirst({
			where: and(
				eq(contentResourceResource.resourceId, solutionId),
				isNull(contentResourceResource.deletedAt),
			),
			with: {
				resourceOf: true,
			},
		})

		if (
			!resourceJoin?.resourceOf ||
			resourceJoin.resourceOf.type !== 'lesson' ||
			resourceJoin.resourceOf.deletedAt
		) {
			return null
		}

		return resourceJoin.resourceOf
	} catch (error) {
		log.error('solution.query.parent-lesson.error', {
			error,
			solutionId,
		})
		return null
	}
}

/**
 * Connect a video resource to a solution
 */
export const addVideoResourceToSolution = async ({
	videoResourceId,
	solutionId,
}: {
	videoResourceId: string
	solutionId: string
}) => {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	// Get the video resource
	const videoResource = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, videoResourceId),
			eq(contentResource.type, 'videoResource'),
		),
		with: {
			resources: true,
		},
	})

	// Get the solution
	const solution = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, solutionId),
			eq(contentResource.type, 'solution'),
		),
		with: {
			resources: true,
		},
	})

	if (!solution) {
		throw new Error(`Solution with id ${solutionId} not found`)
	}

	if (!videoResource) {
		throw new Error(`Video Resource with id ${videoResourceId} not found`)
	}

	// Create the resource join
	await db.insert(contentResourceResource).values({
		resourceOfId: solution.id,
		resourceId: videoResource.id,
		position: solution.resources.length,
	})

	log.info('solution.video.connected', {
		solutionId: solution.id,
		videoResourceId,
		userId: user.id,
	})

	return db.query.contentResourceResource.findFirst({
		where: and(
			eq(contentResourceResource.resourceOfId, solution.id),
			eq(contentResourceResource.resourceId, videoResource.id),
		),
		with: {
			resource: true,
		},
	})
}

/**
 * Get the video resource for a solution
 * Uses the resource join table to find the associated video resource
 */
export const getVideoResourceForSolution = async (solutionIdOrSlug: string) => {
	const query = sql`SELECT cr_video.*
		FROM ${contentResource} AS cr_solution
		JOIN ${contentResourceResource} AS crr ON cr_solution.id = crr.resourceOfId
		JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id
		WHERE (cr_solution.id = ${solutionIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_solution.fields, '$.slug')) = ${solutionIdOrSlug})
			AND cr_video.type = 'videoResource'
			AND cr_solution.type = 'solution'
			AND cr_solution.deletedAt IS NULL
			AND crr.deletedAt IS NULL
		LIMIT 1;`

	try {
		const result = await db.execute(query)

		if (!result.rows.length) return null

		const videoResourceRow = ContentResourceSchema.parse(result.rows[0])

		const videoResource = {
			...videoResourceRow,
			...videoResourceRow.fields,
		}

		return VideoResourceSchema.parse(videoResource)
	} catch (error) {
		log.error('solution.query.video-resource.error', {
			error,
			solutionIdOrSlug,
		})
		return null
	}
}

export const writeSolutionUpdateToDatabase = async (
	solution: SolutionUpdate,
) => {
	void log.info('solution.update.start', {
		solutionId: solution.id,
	})

	try {
		void log.debug('solution.update.db.write', {
			solutionId: solution.id,
		})
		await courseBuilderAdapter.updateContentResourceFields({
			id: solution.id,
			fields: {
				...solution.fields,
			},
		})
		void log.info('solution.update.db.success', {
			solutionId: solution.id,
		})
	} catch (error) {
		void log.error('solution.update.db.error', {
			solutionId: solution.id,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}

	void log.debug('solution.update.fetch', {
		solutionId: solution.id,
	})
	const updatedSolutionRaw = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, solution.id),
			eq(contentResource.type, 'solution'),
		),
		with: {
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
		},
	})

	void log.debug('solution.update.validate', {
		solutionId: solution.id,
	})
	const updatedSolution = SolutionSchema.safeParse(updatedSolutionRaw)

	if (!updatedSolution.success) {
		void log.error('solution.update.validate.error', {
			solutionId: solution.id,
			error: updatedSolution.error.message,
		})
		throw new Error(`Invalid solution data after update for ${solution.id}`)
	}

	if (!updatedSolution.data) {
		void log.error('solution.update.not-found', {
			solutionId: solution.id,
		})
		throw new Error(`Solution with id ${solution.id} not found after update.`)
	}

	try {
		await upsertPostToTypeSense(updatedSolution.data, 'save')
		void log.info('solution.update.typesense.success', {
			solutionId: updatedSolution.data.id,
			action: 'save',
		})
	} catch (error) {
		void log.warn('solution.update.typesense.failed', {
			solutionId: solution.id,
			action: 'save',
			error: error instanceof Error ? error.message : String(error),
		})
		// Don't rethrow - let the solution update succeed even if TypeSense fails
	}

	return updatedSolution.data
}

export async function writeNewSolutionToDatabase(input: NewSolutionInput) {
	void log.info('solution.create.start', {
		parentLessonId: input.parentLessonId,
		createdById: input.createdById,
		hasBody: Boolean(input.body),
		hasDescription: Boolean(input.description),
		providedSlug: Boolean(input.slug),
	})

	try {
		void log.debug('solution.create.validate', {
			parentLessonId: input.parentLessonId,
			createdById: input.createdById,
			hasBody: Boolean(input.body),
			hasDescription: Boolean(input.description),
			providedSlug: Boolean(input.slug),
		})
		const validatedInput = NewSolutionInputSchema.parse(input)
		const { title, parentLessonId, body, slug, description } = validatedInput
		void log.debug('solution.create.validated', {
			parentLessonId,
			createdById: input.createdById,
			hasBody: Boolean(body),
			hasDescription: Boolean(description),
			providedSlug: Boolean(slug),
		})

		const solutionGuid = guid()
		const newSolutionId = `solution_${solutionGuid}`
		void log.info('solution.create.id.generated', {
			solutionId: newSolutionId,
			parentLessonId,
			createdById: input.createdById,
		})

		try {
			// Step 1: Create the core solution
			void log.debug('solution.create.core.start', {
				solutionId: newSolutionId,
				parentLessonId,
			})
			const solution = await courseBuilderAdapter.createContentResource({
				id: newSolutionId,
				type: 'solution',
				fields: {
					title,
					body: body || '',
					slug: slug || `${slugify(title)}~${solutionGuid}`,
					description: description || '',
					state: 'draft',
					visibility: 'unlisted',
				},
				createdById: input.createdById,
			})
			void log.info('solution.create.core.success', {
				solutionId: solution.id,
				parentLessonId,
			})

			// Step 2: Create the link between lesson and solution
			void log.debug('solution.create.link.start', {
				solutionId: solution.id,
				parentLessonId,
			})
			await db.insert(contentResourceResource).values({
				resourceId: solution.id,
				resourceOfId: parentLessonId,
				position: 0,
			})
			void log.info('solution.create.link.success', {
				solutionId: solution.id,
				parentLessonId,
			})

			try {
				await upsertPostToTypeSense(solution, 'save')
				void log.info('solution.create.typesense.success', {
					solutionId: solution.id,
					action: 'save',
				})
			} catch (error) {
				void log.warn('solution.create.typesense.failed', {
					solutionId: solution.id,
					action: 'save',
					error: error instanceof Error ? error.message : String(error),
				})
				// Don't rethrow - let the solution creation succeed even if TypeSense fails
			}

			revalidateTag('solution', 'max')
			revalidateTag('workshop-navigation', 'max')
			return solution
		} catch (error) {
			void log.error('solution.create.error', {
				solutionId: newSolutionId,
				parentLessonId,
				error: error instanceof Error ? error.message : String(error),
			})
			throw new Error(
				'Failed to create solution: ' +
					(error instanceof Error ? error.message : String(error)),
			)
		}
	} catch (error) {
		void log.error('solution.create.validation.error', {
			parentLessonId: input.parentLessonId,
			createdById: input.createdById,
			error: error instanceof Error ? error.message : String(error),
		})
		if (error instanceof z.ZodError) {
			throw new Error('Invalid input for solution creation: ' + error.message)
		}
		throw error
	}
}

export async function deleteSolutionFromDatabase(solutionId: string) {
	try {
		await db.delete(contentResource).where(eq(contentResource.id, solutionId))

		await db
			.delete(contentResourceResource)
			.where(eq(contentResourceResource.resourceId, solutionId))

		try {
			await deletePostInTypeSense(solutionId)
			void log.info('solution.delete.typesense.success', {
				solutionId,
			})
		} catch (error) {
			void log.warn('solution.delete.typesense.failed', {
				solutionId,
				error: error instanceof Error ? error.message : String(error),
			})
			// Continue with database deletion even if TypeSense fails
		}

		revalidateTag('solution', 'max')
		revalidateTag('workshop-navigation', 'max')
	} catch (error) {
		void log.error('solution.delete.error', {
			solutionId,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}
