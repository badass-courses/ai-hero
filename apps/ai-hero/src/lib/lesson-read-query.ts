import 'server-only'

import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag,
} from '@/db/schema'
import { env } from '@/env.mjs'
import { LessonSchema, type Lesson } from '@/lib/lessons'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { Redis } from '@upstash/redis'
import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
	ContentResourceSchema,
	type ContentResourceResource,
} from '@coursebuilder/core/schemas'
import { VideoResourceSchema } from '@coursebuilder/core/schemas/video-resource'
import { last } from '@coursebuilder/nodash'

import { SolutionSchema } from './solution'
import { getCachedSolution } from './solutions-query'

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

			const notFoundKey = `lesson:not-found:${env.NEXT_PUBLIC_APP_NAME}:${lessonSlugOrId}`
			let lesson = cachedLesson

			if (!cachedLesson && !(await redis.get(notFoundKey))) {
				const findLesson = (
					condition: ReturnType<typeof eq>,
					orderBy?: ReturnType<typeof asc>[],
				) =>
					db.query.contentResource.findFirst({
						orderBy,
						where: and(
							condition,
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

				lesson =
					(await findLesson(eq(contentResource.id, lessonSlugOrId))) ??
					(await findLesson(
						eq(
							sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
							lessonSlugOrId,
						),
						// Preserve the type index's tie-break for duplicate slugs.
						[asc(contentResource.type), asc(contentResource.id)],
					)) ??
					(await findLesson(
						like(contentResource.id, `%${last(lessonSlugOrId.split('-'))}%`),
					))

				if (!lesson) {
					await redis.set(notFoundKey, true, { ex: 60 })
				}
			}

			// An unknown slug or id (crawlers, section ids) is a miss, not a schema failure.
			if (!lesson) {
				await log.debug('lesson.not_found', { slug: lessonSlugOrId })
				return null
			}

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

	if (!lesson) {
		await log.debug('lesson.not_found', { slug: lessonSlugOrId })
		return null
	}

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
	// Most lessons have no solution; the solution page turns null into a 404.
	if (!partialSolution) return null

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
