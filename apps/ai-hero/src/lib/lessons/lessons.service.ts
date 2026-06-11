import { revalidatePath, revalidateTag } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag,
} from '@/db/schema'
import {
	LessonActionSchema,
	LessonSchema,
	LessonUpdateSchema,
	NewLessonInputSchema,
	type LessonAction,
} from '@/lib/lessons'
import { log } from '@/server/logger'
import { Ability, subject } from '@casl/ability'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import {
	deleteLessonFromDatabase,
	getAllLessons,
	writeLessonUpdateToDatabase,
	writeNewLessonToDatabase,
} from '../lessons-query'
import {
	deletePostInTypeSense,
	upsertPostToTypeSense,
} from '../typesense-query'
import { getWorkshopsForLesson } from '../workshops-query'

export class LessonError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public details?: unknown,
	) {
		super(message)
	}
}

export async function getLesson(slugOrId: string, ability: Ability) {
	void log.debug('lesson.query', {
		phase: 'start',
		slugOrId,
	})

	const visibility: ('public' | 'private' | 'unlisted')[] = ability.can(
		'update',
		'Content',
	)
		? ['public', 'private', 'unlisted']
		: ['public', 'unlisted']
	const states: ('draft' | 'published')[] = ability.can('update', 'Content')
		? ['draft', 'published']
		: ['published']

	const lesson = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
				eq(contentResource.id, slugOrId),
				eq(contentResource.id, `lesson_${slugOrId.split('~')[1]}`),
			),
			eq(contentResource.type, 'lesson'),
			inArray(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
				visibility,
			),
			inArray(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, states),
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
				orderBy: asc(contentResourceTag.position),
			},
		},
	})

	if (!lesson) {
		void log.warn('lesson.query.not-found', {
			slugOrId,
		})
		return null
	}

	const lessonParsed = LessonSchema.safeParse(lesson)
	if (!lessonParsed.success) {
		void log.error('lesson.query.error', {
			slugOrId,
			lessonId: lesson.id,
			error: lessonParsed.error.message,
		})
		throw new LessonError(
			'Invalid lesson data in database',
			500,
			lessonParsed.error,
		)
	}

	void log.debug('lesson.query', {
		phase: 'found',
		slugOrId,
		lessonId: lessonParsed.data.id,
	})

	const parentResources = await getWorkshopsForLesson(lessonParsed.data.id)
	void log.debug('lesson.query', {
		phase: 'parent-resources',
		lessonId: lessonParsed.data.id,
		parentResourceCount: parentResources.length,
	})

	return {
		...lessonParsed.data,
		parentResources,
	}
}

// New function that doesn't require session
export async function getLessonById({
	id,
	ability,
}: {
	id: string
	ability: Ability
}) {
	void log.debug('lesson.query', {
		phase: 'get-by-id',
		lessonId: id,
	})
	const lesson = await getLesson(id, ability)

	if (!lesson) {
		void log.warn('lesson.query.not-found', {
			lessonId: id,
		})
		throw new LessonError('Lesson not found', 404)
	}

	if (ability.cannot('read', subject('Content', lesson))) {
		void log.warn('lesson.permission-denied', {
			action: 'read',
			lessonId: id,
		})
		throw new LessonError('Unauthorized', 401)
	}

	void log.debug('lesson.query', {
		phase: 'retrieved',
		lessonId: lesson.id,
	})
	return lesson
}

export async function createLesson({
	data,
	userId,
	ability,
}: {
	data: any
	userId: string
	ability: Ability
}) {
	if (ability.cannot('create', 'Content')) {
		throw new LessonError('Unauthorized', 401)
	}

	const validatedData = NewLessonInputSchema.safeParse({
		...data,
		createdById: userId,
	})

	if (!validatedData.success) {
		throw new LessonError('Invalid input', 400, validatedData.error)
	}

	try {
		const lesson = await writeNewLessonToDatabase({
			title: validatedData.data.title,
			videoResourceId: validatedData.data.videoResourceId || undefined,
			lessonType: validatedData.data.lessonType,
			createdById: userId,
		})

		// Index in TypeSense
		try {
			void log.debug('lesson.create.typesense.start', {
				lessonId: lesson.id,
			})
			await upsertPostToTypeSense(lesson, 'save')
			void log.info('lesson.create.typesense.success', {
				lessonId: lesson.id,
			})
		} catch (error) {
			void log.warn('lesson.create.typesense.failed', {
				lessonId: lesson.id,
				error: error instanceof Error ? error.message : String(error),
			})
			// Continue even if TypeSense indexing fails
		}

		return lesson
	} catch (error) {
		throw new LessonError('Failed to create lesson', 500, error)
	}
}

export async function getLessons({
	userId,
	ability,
	slug,
}: {
	userId?: string
	ability: Ability
	slug?: string | null
}) {
	if (slug) {
		void log.debug('lesson.query', {
			phase: 'get-by-slug',
			slugOrId: slug,
		})
		const lesson = await getLesson(slug, ability)

		if (!lesson) {
			void log.warn('lesson.query.not-found', {
				slugOrId: slug,
			})
			throw new LessonError('Lesson not found', 404)
		}

		if (ability.cannot('read', subject('Content', lesson))) {
			void log.warn('lesson.permission-denied', {
				action: 'read',
				lessonId: lesson.id,
				slugOrId: slug,
			})
			throw new LessonError('Unauthorized', 401)
		}

		void log.debug('lesson.query', {
			phase: 'retrieved',
			lessonId: lesson.id,
			slugOrId: slug,
		})
		return lesson
	}

	if (ability.cannot('read', 'Content')) {
		throw new LessonError('Unauthorized', 401)
	}

	return getAllLessons()
}

export async function updateLesson({
	id,
	data,
	action,
	userId,
	ability,
}: {
	id: string
	data: unknown
	action: unknown
	userId: string
	ability: Ability
}) {
	void log.info('lesson.update.start', {
		lessonId: id,
		requestedAction: typeof action === 'string' ? action : undefined,
		userId,
		dataKeys: data ? Object.keys(data as object) : [],
	})

	const actionResult = LessonActionSchema.safeParse(action || 'save')
	if (!actionResult.success) {
		void log.error('lesson.update.invalid-action', {
			lessonId: id,
			requestedAction: typeof action === 'string' ? action : undefined,
			userId,
			error: actionResult.error.message,
		})
		throw new LessonError('Invalid action', 400, actionResult.error)
	}

	void log.debug('lesson.update.fetch', {
		lessonId: id,
		action: actionResult.data,
		userId,
	})
	const originalLesson = await getLesson(id, ability)
	if (!originalLesson) {
		void log.warn('lesson.update.not-found', {
			lessonId: id,
			action: actionResult.data,
			userId,
		})
		throw new LessonError('Lesson not found', 404)
	}

	void log.debug('lesson.update.permission-check', {
		lessonId: id,
		action: actionResult.data,
		userId,
	})
	if (ability.cannot('manage', subject('Content', originalLesson))) {
		void log.warn('lesson.permission-denied', {
			userId,
			lessonId: id,
			action: actionResult.data,
		})
		throw new LessonError('Unauthorized', 401)
	}

	// Handle state transitions for all actions
	const getNewState = (
		action: LessonAction,
	): 'draft' | 'published' | 'archived' | 'deleted' => {
		switch (action) {
			case 'publish':
				return 'published'
			case 'unpublish':
				return 'draft'
			case 'archive':
				return 'archived'
			default:
				return originalLesson.fields.state
		}
	}

	// For state-changing actions, use current lesson data with updated state
	const isStateChange = ['publish', 'unpublish', 'archive'].includes(
		actionResult.data,
	)
	const updateData = isStateChange
		? {
				id,
				fields: {
					...originalLesson.fields,
					state: getNewState(actionResult.data),
				},
			}
		: data

	void log.debug('lesson.update.validate', {
		lessonId: id,
		action: actionResult.data,
		isStateChange,
		newState: isStateChange ? getNewState(actionResult.data) : undefined,
	})

	const validatedData = LessonUpdateSchema.safeParse(updateData)
	if (!validatedData.success) {
		void log.error('lesson.update.invalid-data', {
			lessonId: id,
			action: actionResult.data,
			error: validatedData.error.message,
		})
		throw new LessonError('Invalid input', 400, validatedData.error)
	}

	try {
		void log.info('lesson.update.write', {
			lessonId: id,
			action: actionResult.data,
			fieldCount: Object.keys(validatedData.data?.fields || {}).length,
		})

		const result = await writeLessonUpdateToDatabase({
			currentLesson: originalLesson,
			lessonUpdate: validatedData.data,
			action: actionResult.data,
			updatedById: userId,
		})

		// Update in TypeSense
		try {
			void log.debug('lesson.update.typesense.start', {
				lessonId: result.id,
				action: actionResult.data,
			})
			await upsertPostToTypeSense(result, actionResult.data)
			void log.info('lesson.update.typesense.success', {
				lessonId: result.id,
				action: actionResult.data,
			})
		} catch (error) {
			void log.warn('lesson.update.typesense.failed', {
				lessonId: result.id,
				action: actionResult.data,
				error: error instanceof Error ? error.message : String(error),
			})
			// Continue even if TypeSense update fails
		}

		void log.info('lesson.update.success', {
			lessonId: result.id,
			action: actionResult.data,
			newState: result.fields.state,
		})
		void log.debug('lesson.update.revalidate', {
			lessonId: result.id,
			path: `/${result.fields.slug}`,
		})

		void log.debug('lesson.update.parent-resources.fetch', {
			lessonId: result.id,
		})
		let parentResources = null
		parentResources = await getWorkshopsForLesson(result.id)
		void log.debug('lesson.update.parent-resources.found', {
			lessonId: result.id,
			parentResourceCount: parentResources.length,
		})
		if (parentResources.length > 0) {
			const lessonPath = getResourcePath('lesson', result.fields.slug, 'view', {
				parentType: parentResources[0]?.type as string,
				parentSlug: parentResources[0]?.fields?.slug as string,
			})
			void log.debug('lesson.update.revalidate', {
				lessonId: result.id,
				path: lessonPath,
			})
			revalidatePath(lessonPath)
		}

		// Revalidate workshop navigation tag
		void log.debug('lesson.update.revalidate-tag', {
			lessonId: result.id,
			tag: 'workshop-navigation',
		})
		revalidateTag('workshop-navigation', 'max')

		return result
	} catch (error: any) {
		void log.error('lesson.update.error', {
			lessonId: id,
			action: actionResult.data,
			error: error instanceof Error ? error.message : String(error),
		})
		throw new LessonError('Failed to update lesson', 500, error)
	}
}

export async function deleteLesson({
	id,
	ability,
}: {
	id: string
	ability: Ability
}) {
	if (!id) {
		throw new LessonError('Missing lesson ID', 400)
	}

	const lessonToDelete = await courseBuilderAdapter.getContentResource(id)
	if (!lessonToDelete) {
		throw new LessonError('Lesson not found', 404)
	}

	if (ability.cannot('delete', subject('Content', lessonToDelete))) {
		throw new LessonError('Unauthorized', 401)
	}

	try {
		// Delete from database
		await deleteLessonFromDatabase(id)

		// Delete from TypeSense
		try {
			void log.debug('lesson.delete.typesense.start', {
				lessonId: id,
			})
			await deletePostInTypeSense(id)
			void log.info('lesson.delete.typesense.success', {
				lessonId: id,
			})
		} catch (error) {
			void log.warn('lesson.delete.typesense.failed', {
				lessonId: id,
				error: error instanceof Error ? error.message : String(error),
			})
			// Continue even if TypeSense deletion fails
		}

		void log.debug('lesson.delete.revalidate', {
			lessonId: id,
			path: `/${lessonToDelete.fields?.slug}`,
		})
		revalidatePath(`/${lessonToDelete.fields?.slug}`)

		return { message: 'Lesson deleted successfully' }
	} catch (error) {
		throw new LessonError('Failed to delete lesson', 500, error)
	}
}
