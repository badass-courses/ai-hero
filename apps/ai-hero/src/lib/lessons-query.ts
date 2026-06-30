'use server'

import { revalidateTag, unstable_cache } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag,
} from '@/db/schema'
import { env } from '@/env.mjs'
import {
	LessonSchema,
	NewLessonInputSchema,
	type LessonUpdate,
	type NewLessonInput,
} from '@/lib/lessons'
import { upsertPostToTypeSense } from '@/lib/typesense-query'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { guid } from '@coursebuilder/utils/guid'
import slugify from '@sindresorhus/slugify'
import { Redis } from '@upstash/redis'
import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
	ContentResourceSchema,
	type ContentResourceResource,
} from '@coursebuilder/core/schemas'
import {
	VideoChapterSchema,
	VideoResourceSchema,
} from '@coursebuilder/core/schemas/video-resource'
import { last } from '@coursebuilder/nodash'

import { Lesson } from './lessons'
import { SolutionSchema } from './solution'
import { getCachedSolution, getSolution } from './solutions-query'

const redis = Redis.fromEnv()

function formatZodError(error: z.ZodError): string {
	return (
		error.issues
			.map((issue) => {
				const path = issue.path.length ? issue.path.join('.') : 'root'
				return `${path}: ${issue.message}`
			})
			.join('; ') || error.message
	)
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function getErrorStack(error: unknown): string | undefined {
	return error instanceof Error ? error.stack : undefined
}

function getResourceId(resource: unknown): string | undefined {
	if (
		resource &&
		typeof resource === 'object' &&
		'id' in resource &&
		typeof resource.id === 'string'
	) {
		return resource.id
	}

	return undefined
}

function getResourceSlug(resource: unknown): string | undefined {
	if (
		resource &&
		typeof resource === 'object' &&
		'fields' in resource &&
		resource.fields &&
		typeof resource.fields === 'object' &&
		'slug' in resource.fields &&
		typeof resource.fields.slug === 'string'
	) {
		return resource.fields.slug
	}

	return undefined
}

export const getLessonVideoTranscript = async (
	lessonIdOrSlug?: string | null,
) => {
	if (!lessonIdOrSlug) return null

	return measureIfSlow({
		event: 'perf.lesson.transcript.slow',
		spanName: 'lesson.transcript.fetch',
		thresholdMs: 100,
		data: { lessonIdOrSlug },
		operation: async () => {
			const query = sql`SELECT cr_video.fields->>'$.transcript' AS transcript
				FROM ${contentResource} AS cr_lesson
				JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
				JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id

				WHERE (cr_lesson.id = ${lessonIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_lesson.fields, '$.slug')) = ${lessonIdOrSlug})
					AND cr_video.type = 'videoResource'
				LIMIT 1;`
			const result = await db.execute(query)

			const parsedResult = z
				.array(z.object({ transcript: z.string() }))
				.safeParse(result.rows)

			if (!parsedResult.success) {
				await log.error('lesson.transcript.error', {
					lessonId: lessonIdOrSlug,
					slug: lessonIdOrSlug,
					error: formatZodError(parsedResult.error),
				})
				return null
			}

			return parsedResult.data[0]?.transcript
		},
	})
}

export const getVideoResourceForLesson = async (lessonIdOrSlug: string) => {
	const query = sql`SELECT *
		FROM ${contentResource} AS cr_lesson
		JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
		JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id
		WHERE (cr_lesson.id = ${lessonIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_lesson.fields, '$.slug')) = ${lessonIdOrSlug})
			AND cr_video.type = 'videoResource'
		LIMIT 1;`

	const result = await db.execute(query)

	if (!result.rows.length) return null

	const videoResourceRow = ContentResourceSchema.parse(result.rows[0])

	const videoResource = {
		...videoResourceRow,
		...videoResourceRow.fields,
	}

	return VideoResourceSchema.parse(videoResource)
}

const LessonVideoPlaybackResourceSchema = z.object({
	id: z.string(),
	muxPlaybackId: z.string().nullable().optional(),
	chapters: z.preprocess((value) => {
		if (typeof value !== 'string') return value
		try {
			return JSON.parse(value)
		} catch {
			return value
		}
	}, z.array(VideoChapterSchema).nullable().optional()),
})

export const getLessonVideoPlaybackResource = async (
	lessonIdOrSlug: string,
) => {
	return measureIfSlow({
		event: 'perf.lesson.video-playback-resource.slow',
		spanName: 'lesson.video-playback-resource.fetch',
		thresholdMs: 100,
		data: { lessonIdOrSlug },
		operation: async () => {
			const query = sql`SELECT
					cr_video.id AS id,
					cr_video.fields->>'$.muxPlaybackId' AS muxPlaybackId,
					JSON_EXTRACT(cr_video.fields, '$.chapters') AS chapters
				FROM ${contentResource} AS cr_lesson
				JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
				JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id
				WHERE (cr_lesson.id = ${lessonIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_lesson.fields, '$.slug')) = ${lessonIdOrSlug})
					AND cr_video.type = 'videoResource'
				LIMIT 1;`
			const result = await db.execute(query)

			const parsedResult = z
				.array(LessonVideoPlaybackResourceSchema)
				.safeParse(result.rows)

			if (!parsedResult.success) {
				await log.error('lesson.video-playback-resource.error', {
					lessonId: lessonIdOrSlug,
					slug: lessonIdOrSlug,
					error: formatZodError(parsedResult.error),
				})
				return null
			}

			return parsedResult.data[0] ?? null
		},
	})
}

export const getLessonMuxPlaybackId = async (lessonIdOrSlug: string) => {
	return measureIfSlow({
		event: 'perf.lesson.playback-id.slow',
		spanName: 'lesson.playback-id.fetch',
		thresholdMs: 100,
		data: { lessonIdOrSlug },
		operation: async () => {
			const query = sql`SELECT cr_video.fields->>'$.muxPlaybackId' AS muxPlaybackId
				FROM ${contentResource} AS cr_lesson
				JOIN ${contentResourceResource} AS crr ON cr_lesson.id = crr.resourceOfId
				JOIN ${contentResource} AS cr_video ON crr.resourceId = cr_video.id
				WHERE (cr_lesson.id = ${lessonIdOrSlug} OR JSON_UNQUOTE(JSON_EXTRACT(cr_lesson.fields, '$.slug')) = ${lessonIdOrSlug})
					AND cr_video.type = 'videoResource'
				LIMIT 1;`
			const result = await db.execute(query)

			const parsedResult = z
				.array(z.object({ muxPlaybackId: z.string() }))
				.safeParse(result.rows)

			if (!parsedResult.success) {
				await log.error('lesson.parse.error', {
					lessonId: lessonIdOrSlug,
					slug: lessonIdOrSlug,
					error: formatZodError(parsedResult.error),
					source: 'muxPlaybackId',
				})
				return null
			}

			return parsedResult.data[0]?.muxPlaybackId
		},
	})
}

export const addVideoResourceToLesson = async ({
	videoResourceId,
	lessonId,
}: {
	videoResourceId: string
	lessonId: string
}) => {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const videoResource = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, videoResourceId),
			eq(contentResource.type, 'videoResource'),
		),
		with: {
			resources: true,
		},
	})

	const lesson = await db.query.contentResource.findFirst({
		where: and(
			like(contentResource.id, `%${last(lessonId.split('-'))}%`),
			or(
				eq(contentResource.type, 'lesson'),
				eq(contentResource.type, 'exercise'),
				eq(contentResource.type, 'solution'),
			),
		),
		with: {
			resources: true,
		},
	})

	if (!lesson) {
		throw new Error(`Lesson with id ${lessonId} not found`)
	}

	if (!videoResource) {
		throw new Error(`Video Resource with id ${videoResourceId} not found`)
	}

	await db.insert(contentResourceResource).values({
		resourceOfId: lesson.id,
		resourceId: videoResource.id,
		position: lesson.resources.length,
	})

	return db.query.contentResourceResource.findFirst({
		where: and(
			eq(contentResourceResource.resourceOfId, lesson.id),
			eq(contentResourceResource.resourceId, videoResource.id),
		),
		with: {
			resource: true,
		},
	})
}

export const getCachedLesson = unstable_cache(
	async (slug: string) => getLesson(slug),
	['lesson'],
	{ revalidate: 3600, tags: ['lesson'] },
)

export async function getLesson(lessonSlugOrId: string) {
	return measureIfSlow({
		event: 'perf.lesson.fetch.slow',
		spanName: 'lesson.fetch',
		thresholdMs: 100,
		data: { lessonSlugOrId },
		operation: async () => {
			const cachedLesson = await redis.get(
				`lesson:${env.NEXT_PUBLIC_APP_NAME}:${lessonSlugOrId}`,
			)

			const lesson = cachedLesson
				? cachedLesson
				: await db.query.contentResource.findFirst({
						where: and(
							or(
								eq(
									sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
									lessonSlugOrId,
								),
								eq(contentResource.id, lessonSlugOrId),
								like(
									contentResource.id,
									`%${last(lessonSlugOrId.split('-'))}%`,
								),
							),
							or(
								eq(contentResource.type, 'lesson'),
								eq(contentResource.type, 'exercise'),
								eq(contentResource.type, 'solution'),
								eq(contentResource.type, 'post'),
							),
						),
						with: {
							tags: {
								with: {
									tag: true,
								},
								orderBy: asc(contentResourceTag.position),
							},
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

			const parsedLesson = LessonSchema.safeParse(lesson)
			if (!parsedLesson.success) {
				await log.error('lesson.parse.error', {
					lessonId: getResourceId(lesson) ?? lessonSlugOrId,
					slug: getResourceSlug(lesson),
					error: formatZodError(parsedLesson.error),
					source: 'getLesson',
				})
				return null
			}

			if (!cachedLesson) {
				await redis.set(
					`lesson:${env.NEXT_PUBLIC_APP_NAME}:${lessonSlugOrId}`,
					lesson,
					{ ex: 10 },
				)
			}

			return parsedLesson.data
		},
	})
}

export const getCachedExerciseSolution = unstable_cache(
	async (slug: string) => getExerciseSolution(slug),
	['solution'],
	{ revalidate: 3600, tags: ['solution'] },
)

export async function getExerciseSolution(lessonSlugOrId: string) {
	const lesson = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(
					sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
					lessonSlugOrId,
				),
				eq(contentResource.id, lessonSlugOrId),
			),
			or(
				eq(contentResource.type, 'lesson'),
				eq(contentResource.type, 'exercise'),
				eq(contentResource.type, 'solution'),
			),
		),
		with: {
			resources: {
				with: {
					resource: {
						columns: {
							type: true,
							id: true,
						},
					},
				},
				orderBy: asc(contentResourceResource.position),
			},
		},
	})

	const parsedLesson = LessonSchema.safeParse(lesson)
	if (!parsedLesson.success) {
		await log.error('lesson.parse.error', {
			lessonId: lesson?.id ?? lessonSlugOrId,
			slug: lesson?.fields?.slug,
			error: formatZodError(parsedLesson.error),
			source: 'getExerciseSolution.lesson',
		})
		return null
	}

	const partialSolution = parsedLesson.data?.resources?.find(
		(resource: ContentResourceResource) =>
			resource.resource.type === 'solution',
	)?.resource

	const solution = await getCachedSolution(partialSolution.id)

	const parsedSolution = SolutionSchema.safeParse(solution)
	if (!parsedSolution.success) {
		await log.error('lesson.parse.error', {
			lessonId: parsedLesson.data.id,
			slug: parsedLesson.data.fields.slug,
			error: formatZodError(parsedSolution.error),
			source: 'getExerciseSolution.solution',
		})
		return null
	}
	return { solution: parsedSolution.data, lesson: parsedLesson.data }
}

export async function updateLesson(input: LessonUpdate, revalidate = true) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	if (!user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	// Ensure we have an ID to look up
	const id = input.id
	if (!id) {
		throw new Error('Lesson ID is required for updates')
	}

	const currentLesson = await getLesson(id)

	if (!currentLesson) {
		throw new Error(`Lesson with id ${id} not found.`)
	}

	let lessonSlug = currentLesson.fields.slug

	// Handle both PostUpdate and Lesson formats
	let titleFromInput: string | undefined
	let fieldsToUpdate: Record<string, any> = {}

	// Safely extract fields regardless of input type
	if (input.fields) {
		fieldsToUpdate = input.fields
		titleFromInput = input.fields.title
	}

	if (titleFromInput && titleFromInput !== currentLesson.fields.title) {
		const splitSlug = currentLesson?.fields.slug.split('~') || ['', guid()]
		lessonSlug = `${slugify(titleFromInput)}~${splitSlug[1] || guid()}`
	}

	const updatedLesson = {
		...currentLesson,
		fields: {
			...currentLesson.fields,
			...fieldsToUpdate,
			slug: lessonSlug,
		},
	}

	// Update the lesson
	const updatedResource = courseBuilderAdapter.updateContentResourceFields({
		id: currentLesson.id,
		fields: updatedLesson.fields,
	})

	// Index the lesson in Typesense using the existing post indexing function
	try {
		await upsertPostToTypeSense(updatedLesson, 'save')
		await log.info('lesson.typesense.indexed', {
			lessonId: updatedLesson.id,
			slug: updatedLesson.fields.slug,
			action: 'save',
		})
	} catch (error) {
		await log.error('lesson.typesense.error', {
			lessonId: updatedLesson.id,
			slug: updatedLesson.fields.slug,
			action: 'save',
			error: getErrorMessage(error),
			stack: getErrorStack(error),
		})
	}

	if (revalidate) {
		revalidateTag('lesson', 'max')
		revalidateTag('workshop-navigation', 'max')
	}

	return updatedResource
}

export async function autoUpdateLesson(input: LessonUpdate) {
	return await updateLesson(input, false)
}

export async function getAllLessons(): Promise<Lesson[]> {
	const lessons = await db.query.contentResource.findMany({
		where: and(eq(contentResource.type, 'lesson')),
		with: {
			tags: {
				with: {
					tag: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
		},

		orderBy: desc(contentResource.createdAt),
	})

	// Parse per-row so one malformed lesson is skipped and logged rather than
	// blanking the entire list — list-all consumers (e.g. the read-only CLI)
	// otherwise can't tell "no lessons" from "one bad row dropped everything".
	const parsed: Lesson[] = []
	for (const lesson of lessons) {
		const result = LessonSchema.safeParse(lesson)
		if (result.success) {
			parsed.push(result.data)
		} else {
			await log.error('lesson.parse.error', {
				error: formatZodError(result.error),
				source: 'getAllLessons',
				lessonId: lesson.id,
			})
		}
	}

	return parsed
}

export async function writeNewLessonToDatabase(
	input: NewLessonInput,
): Promise<Lesson> {
	try {
		await log.debug('lesson.create', {
			stage: 'validate.start',
			slug: input.title ? slugify(input.title) : undefined,
			videoResourceId: input.videoResourceId,
		})
		const validatedInput = NewLessonInputSchema.parse(input)
		const { title, videoResourceId, lessonType, createdById } = validatedInput
		await log.debug('lesson.create', {
			stage: 'validate.success',
			slug: slugify(title),
			videoResourceId,
			lessonType,
			createdById,
		})

		const lessonGuid = guid()
		const newLessonId = `lesson_${lessonGuid}`
		const lessonSlug = `${slugify(title)}~${lessonGuid}`
		await log.info('lesson.create', {
			stage: 'initialized',
			lessonId: newLessonId,
			slug: lessonSlug,
			videoResourceId,
			lessonType,
			createdById,
		})

		// Step 1: Get video resource if needed
		let videoResource = null
		if (videoResourceId) {
			await log.debug('lesson.create', {
				stage: 'video.fetch.start',
				lessonId: newLessonId,
				slug: lessonSlug,
				videoResourceId,
			})
			videoResource =
				await courseBuilderAdapter.getVideoResource(videoResourceId)
			await log.debug('lesson.create', {
				stage: 'video.fetch.complete',
				lessonId: newLessonId,
				slug: lessonSlug,
				videoResourceId: videoResource?.id ?? videoResourceId,
			})
		}

		try {
			// Wrap database operations in a transaction
			const lesson = await db.transaction(async (tx) => {
				// Step 2: Create the core lesson
				await log.debug('lesson.create', {
					stage: 'core.start',
					lessonId: newLessonId,
					slug: lessonSlug,
					videoResourceId,
				})
				const lesson = await createCoreLesson({
					newLessonId,
					title,
					lessonGuid,
					lessonType,
					createdById,
					tx, // Pass transaction context
				})
				await log.info('lesson.create', {
					stage: 'core.created',
					lessonId: lesson.id,
					slug: lesson.fields.slug,
					videoResourceId,
				})

				// Step 3: Link video resource if provided
				if (videoResourceId) {
					await log.debug('lesson.create.video-linked', {
						stage: 'start',
						lessonId: lesson.id,
						slug: lesson.fields.slug,
						videoResourceId,
					})
					await tx.insert(contentResourceResource).values({
						resourceOfId: lesson.id,
						resourceId: videoResourceId,
						position: 0,
					})
					await log.info('lesson.create.video-linked', {
						stage: 'complete',
						lessonId: lesson.id,
						slug: lesson.fields.slug,
						videoResourceId,
					})
				}

				return lesson
			})

			// Step 4: Index the lesson in Typesense (outside transaction since it's a separate system)
			try {
				await log.debug('lesson.typesense.index', {
					lessonId: lesson.id,
					slug: lesson.fields.slug,
					action: 'save',
				})
				await upsertPostToTypeSense(lesson, 'save')
				await log.info('lesson.typesense.indexed', {
					lessonId: lesson.id,
					slug: lesson.fields.slug,
					action: 'save',
				})
			} catch (error) {
				await log.error('lesson.typesense.error', {
					lessonId: lesson.id,
					slug: lesson.fields.slug,
					action: 'save',
					error: getErrorMessage(error),
					stack: getErrorStack(error),
				})
				// Continue even if TypeSense indexing fails
			}

			return lesson
		} catch (error) {
			await log.error('lesson.create', {
				stage: 'flow.error',
				lessonId: newLessonId,
				slug: lessonSlug,
				videoResourceId,
				error: getErrorMessage(error),
				stack: getErrorStack(error),
			})
			throw new Error(
				'Failed to create lesson: ' +
					(error instanceof Error ? error.message : String(error)),
			)
		}
	} catch (error) {
		await log.error('lesson.parse.error', {
			slug: input.title ? slugify(input.title) : undefined,
			videoResourceId: input.videoResourceId,
			error:
				error instanceof z.ZodError
					? formatZodError(error)
					: getErrorMessage(error),
			stack: getErrorStack(error),
			source: 'writeNewLessonToDatabase.input',
		})
		if (error instanceof z.ZodError) {
			throw new Error('Invalid input for lesson creation: ' + error.message)
		}
		throw error
	}
}

// Helper function that accepts transaction context
async function createCoreLesson({
	newLessonId,
	title,
	lessonGuid,
	lessonType,
	createdById,
	tx,
}: {
	newLessonId: string
	title: string
	lessonGuid: string
	lessonType: string
	createdById: string
	tx?: any // Transaction context
}): Promise<Lesson> {
	const lessonSlug = `${slugify(title)}~${lessonGuid}`

	try {
		await log.debug('lesson.create', {
			stage: 'core.insert.start',
			lessonId: newLessonId,
			slug: lessonSlug,
			lessonType,
			createdById,
		})

		const dbContext = tx || db // Use transaction context if provided, otherwise use db

		await dbContext.insert(contentResource).values({
			id: newLessonId,
			type: 'lesson',
			createdById,
			fields: {
				title,
				state: 'draft',
				visibility: 'unlisted',
				slug: lessonSlug,
				lessonType,
			},
		})
		await log.info('lesson.create', {
			stage: 'core.inserted',
			lessonId: newLessonId,
			slug: lessonSlug,
			createdById,
		})

		// Direct query by ID without filters
		const lesson = await dbContext.query.contentResource.findFirst({
			where: eq(contentResource.id, newLessonId),
			with: {
				resources: {
					with: {
						resource: true,
					},
					orderBy: asc(contentResourceResource.position),
				},
				tags: {
					with: {
						tag: true,
					},
				},
			},
		})
		await log.debug('lesson.create', {
			stage: 'core.retrieved',
			lessonId: lesson?.id ?? newLessonId,
			slug: lesson?.fields?.slug ?? lessonSlug,
		})

		if (!lesson) {
			await log.error('lesson.create', {
				stage: 'core.notfound',
				lessonId: newLessonId,
				slug: lessonSlug,
				error: 'Lesson not found after creation',
			})
			throw new Error('Lesson not found after creation')
		}

		const lessonParsed = LessonSchema.safeParse(lesson)
		if (!lessonParsed.success) {
			await log.error('lesson.parse.error', {
				lessonId: newLessonId,
				slug: lesson.fields.slug,
				error: formatZodError(lessonParsed.error),
				source: 'createCoreLesson',
			})
			throw new Error('Invalid lesson data')
		}

		return lessonParsed.data
	} catch (error) {
		await log.error('lesson.create', {
			stage: 'core.error',
			lessonId: newLessonId,
			slug: lessonSlug,
			error: getErrorMessage(error),
			stack: getErrorStack(error),
		})
		throw new Error(
			'Failed to create core lesson: ' +
				(error instanceof Error ? error.message : String(error)),
		)
	}
}

export async function writeLessonUpdateToDatabase(input: {
	currentLesson?: Lesson
	lessonUpdate: LessonUpdate
	action: 'save' | 'publish' | 'unpublish' | 'archive'
	updatedById: string
}) {
	const {
		currentLesson = await getLesson(input.lessonUpdate.id),
		lessonUpdate,
		action = 'save',
		updatedById,
	} = input

	await log.info('lesson.update', {
		stage: 'start',
		lessonId: lessonUpdate.id,
		action,
		updatedById,
		hasCurrentLesson: !!currentLesson,
		updatedFields: lessonUpdate.fields ? Object.keys(lessonUpdate.fields) : [],
		slug: currentLesson?.fields.slug,
	})

	if (!currentLesson) {
		await log.error('lesson.update.error', {
			lessonId: lessonUpdate.id,
			action,
			updatedById,
			error: 'Current lesson not found',
		})
		throw new Error(`Lesson with id ${input.lessonUpdate.id} not found.`)
	}

	if (lessonUpdate.fields?.title === '') {
		await log.error('lesson.update.error', {
			lessonId: lessonUpdate.id,
			slug: currentLesson.fields.slug,
			action,
			updatedById,
			error: 'Title is required for update',
		})
		throw new Error('Title is required')
	}

	let lessonSlug = currentLesson.fields.slug

	if (
		lessonUpdate.fields?.title &&
		lessonUpdate.fields.title !== currentLesson.fields.title
	) {
		const splitSlug = currentLesson?.fields.slug.split('~') || ['', guid()]
		lessonSlug = `${slugify(lessonUpdate.fields.title)}~${splitSlug[1] || guid()}`
		await log.info('lesson.update', {
			stage: 'slug.updated',
			lessonId: currentLesson.id,
			slug: lessonSlug,
			previousSlug: currentLesson.fields.slug,
			action,
			updatedById,
		})
	}

	try {
		await log.debug('lesson.update', {
			stage: 'db.update.start',
			lessonId: currentLesson.id,
			slug: lessonSlug,
			action,
			updatedById,
		})
		await courseBuilderAdapter.updateContentResourceFields({
			id: currentLesson.id,
			fields: {
				...currentLesson.fields,
				...lessonUpdate.fields,
				slug: lessonSlug,
			},
		})
		await log.info('lesson.update', {
			stage: 'db.update.complete',
			lessonId: currentLesson.id,
			slug: lessonSlug,
			action,
			updatedById,
		})
	} catch (error) {
		await log.error('lesson.update.error', {
			lessonId: currentLesson.id,
			slug: lessonSlug,
			action,
			updatedById,
			error: getErrorMessage(error),
			stack: getErrorStack(error),
		})
		throw error
	}

	await log.debug('lesson.update', {
		stage: 'fetch.updated',
		lessonId: currentLesson.id,
		slug: lessonSlug,
		action,
		updatedById,
	})
	const updatedLessonRaw = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, currentLesson.id),
			eq(contentResource.type, 'lesson'),
		),
		with: {
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: {
					tag: true,
				},
			},
		},
	})

	await log.debug('lesson.update', {
		stage: 'validate.updated',
		lessonId: currentLesson.id,
		slug: lessonSlug,
		action,
		updatedById,
	})
	const updatedLesson = LessonSchema.safeParse(updatedLessonRaw)

	if (!updatedLesson.success) {
		await log.error('lesson.parse.error', {
			lessonId: currentLesson.id,
			slug: lessonSlug,
			action,
			error: formatZodError(updatedLesson.error),
			source: 'writeLessonUpdateToDatabase',
		})
		throw new Error(`Invalid lesson data after update for ${currentLesson.id}`)
	}

	if (!updatedLesson.data) {
		await log.error('lesson.update.error', {
			lessonId: currentLesson.id,
			slug: lessonSlug,
			action,
			updatedById,
			error: 'Updated lesson not found',
		})
		throw new Error(
			`Lesson with id ${currentLesson.id} not found after update.`,
		)
	}

	// Index the lesson in Typesense
	try {
		await log.debug('lesson.update', {
			stage: 'typesense.upsert.start',
			lessonId: updatedLesson.data.id,
			slug: updatedLesson.data.fields.slug,
			action,
			updatedById,
		})
		await upsertPostToTypeSense(updatedLesson.data, action)
		await log.info('lesson.typesense.indexed', {
			lessonId: updatedLesson.data.id,
			slug: updatedLesson.data.fields.slug,
			action,
		})
	} catch (error) {
		await log.error('lesson.typesense.error', {
			lessonId: updatedLesson.data.id,
			slug: updatedLesson.data.fields.slug,
			action,
			error: getErrorMessage(error),
			stack: getErrorStack(error),
		})
		// Don't rethrow - let the lesson update succeed even if TypeSense fails
	}

	return updatedLesson.data
}

export async function deleteLessonFromDatabase(id: string) {
	await log.info('lesson.delete.started', { lessonId: id })

	try {
		const rawLesson = await db.query.contentResource.findFirst({
			where: and(
				eq(contentResource.id, id),
				eq(contentResource.type, 'lesson'),
			),
			with: {
				resources: {
					with: {
						resource: true,
					},
					orderBy: asc(contentResourceResource.position),
				},
				tags: {
					with: {
						tag: true,
					},
				},
			},
		})

		const lesson = LessonSchema.nullish().safeParse(rawLesson)

		if (!lesson.success || !lesson.data) {
			await log.error('lesson.delete.notfound', {
				lessonId: id,
				parseError: lesson.success ? undefined : lesson.error.format(),
			})
			throw new Error(`Lesson with id ${id} not found or invalid.`)
		}

		await log.info('lesson.delete.resources.started', {
			lessonId: id,
			resourceCount: lesson.data.resources?.length,
		})

		// Delete lesson resources
		await db
			.delete(contentResourceResource)
			.where(eq(contentResourceResource.resourceOfId, id))

		// Delete the lesson itself
		await log.info('lesson.delete.content.started', { lessonId: id })
		await db.delete(contentResource).where(eq(contentResource.id, id))

		await log.info('lesson.delete.completed', { lessonId: id })
		return true
	} catch (error) {
		await log.error('lesson.delete.failed', {
			lessonId: id,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})
		throw error
	}
}
