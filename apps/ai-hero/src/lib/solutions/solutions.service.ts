import { log } from '@/server/logger'
import { Ability, subject } from '@casl/ability'

import { getLesson } from '../lessons/lessons.service'
import type { NewSolutionInput, SolutionUpdate } from '../solution'
import {
	deleteSolutionFromDatabase,
	getSolutionForLesson as getSolutionForLessonQuery,
	writeNewSolutionToDatabase,
	writeSolutionUpdateToDatabase,
} from '../solutions-query'

export class SolutionError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public details?: unknown,
	) {
		super(message)
	}
}

export async function getSolutionForLesson(lessonId: string, ability: Ability) {
	const lesson = await getLesson(lessonId, ability)
	if (!lesson) {
		void log.warn('solution.query.lesson.not-found', {
			lessonId,
		})
		throw new SolutionError('Lesson not found', 404)
	}

	if (ability.cannot('read', subject('Content', lesson))) {
		void log.warn('solution.permission-denied', {
			action: 'read',
			lessonId,
		})
		throw new SolutionError('Unauthorized', 401)
	}

	const solution = await getSolutionForLessonQuery(lessonId)

	if (!solution) {
		void log.warn('solution.query.not-found', {
			lessonId,
		})
		throw new SolutionError('Solution not found', 404)
	}

	return solution
}

export async function updateSolutionForLesson(
	lessonId: string,
	ability: Ability,
	data: SolutionUpdate,
	userId: string,
) {
	const lesson = await getLesson(lessonId, ability)
	if (!lesson) {
		void log.warn('solution.update.lesson.not-found', {
			lessonId,
		})
		throw new SolutionError('Lesson not found', 404)
	}

	void log.debug('solution.update.permission-check', {
		lessonId,
		userId,
	})
	if (ability.cannot('manage', subject('Content', lesson))) {
		void log.warn('solution.permission-denied', {
			userId,
			lessonId,
			action: 'update',
		})
		throw new SolutionError('Forbidden', 403)
	}

	const solution = await getSolutionForLessonQuery(lessonId)
	if (!solution) {
		void log.warn('solution.update.not-found', {
			lessonId,
		})
		throw new SolutionError('Solution not found', 404)
	}

	const updatedSolution = await writeSolutionUpdateToDatabase({
		...data,
		id: solution.id,
	})

	return updatedSolution
}

export async function createSolutionForLesson(
	lessonId: string,
	ability: Ability,
	data: NewSolutionInput,
	userId: string,
) {
	const lesson = await getLesson(lessonId, ability)

	if (!lesson) {
		void log.warn('solution.create.lesson.not-found', {
			lessonId,
		})
		throw new SolutionError('Lesson not found', 404)
	}

	if (ability.cannot('manage', subject('Content', lesson))) {
		void log.warn('solution.permission-denied', {
			userId,
			lessonId: lesson.id,
			action: 'create',
		})
		throw new SolutionError('Forbidden', 403)
	}

	const existingSolution = await getSolutionForLessonQuery(lesson.id)

	if (existingSolution) {
		void log.warn('solution.create.already-exists', {
			lessonId: lesson.id,
			solutionId: existingSolution.id,
		})
		throw new SolutionError('Solution already exists', 400)
	}

	const solution = await writeNewSolutionToDatabase({
		...data,
		parentLessonId: lesson.id,
		createdById: userId,
	})

	return solution
}

export async function deleteSolutionForLesson(
	lessonId: string,
	ability: Ability,
	userId: string,
) {
	const lesson = await getLesson(lessonId, ability)
	if (!lesson) {
		void log.warn('solution.delete.lesson.not-found', {
			lessonId,
		})
		throw new SolutionError('Lesson not found', 404)
	}

	if (ability.cannot('manage', subject('Content', lesson))) {
		void log.warn('solution.permission-denied', {
			userId,
			lessonId: lesson.id,
			action: 'delete',
		})
		throw new SolutionError('Forbidden', 403)
	}

	const solution = await getSolutionForLessonQuery(lesson.id)

	if (!solution) {
		void log.warn('solution.delete.not-found', {
			lessonId: lesson.id,
		})
		throw new SolutionError('Solution not found', 404)
	}

	await deleteSolutionFromDatabase(solution.id)

	return { message: 'Solution deleted' }
}
