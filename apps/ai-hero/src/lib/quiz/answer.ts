import { gradeAnswer } from './grade-answer'
import { z } from 'zod'

const AnswerSchema = z.union([
	z.string().trim().min(1),
	z.array(z.string().trim().min(1)).min(1),
])

export const QuizAnswerInputSchema = z.object({
	lessonId: z.string().trim().min(1),
	questionId: z.string().trim().min(1),
	answer: AnswerSchema,
})

export type QuizAnswerInput = z.infer<typeof QuizAnswerInputSchema>

export type QuizAnswerIdentity = {
	respondentKey: string
	surveySessionId: null
	userId: string
	emailListSubscriberId: null
}

export type QuizAnswerQuestion = {
	id: string
	correct: string | string[]
}

export type QuizAnswerRecord = QuizAnswerIdentity & {
	id: string
	surveyId: string
	questionId: string
	fields: {
		answer: string | string[]
		correct: boolean
	}
	createdAt: Date
	updatedAt: Date
}

type QuizAnswerLogger = {
	info(event: string, data: Record<string, unknown>): Promise<unknown>
	error(event: string, data: Record<string, unknown>): Promise<unknown>
}

type QuizAnswerDependencies = {
	resolveIdentity(): Promise<QuizAnswerIdentity>
	findQuestion(input: {
		lessonId: string
		authoredQuestionId: string
	}): Promise<QuizAnswerQuestion | null>
	upsertResponse(record: QuizAnswerRecord): Promise<void>
	newId(): string
	now(): Date
	log: QuizAnswerLogger
}

export class QuizQuestionNotFoundError extends Error {
	constructor(lessonId: string, questionId: string) {
		super(`Quiz question ${questionId} was not synced for lesson ${lessonId}`)
		this.name = 'QuizQuestionNotFoundError'
	}
}

/**
 * Quiz persistence is authenticated. respondentKey answers "who" with one
 * stable value across devices. surveySessionId stays null because this endpoint
 * no longer creates or tracks an anonymous browser session.
 */
export function quizRespondentKey(userId: string): string {
	return `user:${userId}`
}

export async function submitQuizAnswer(
	input: QuizAnswerInput,
	answerAttemptId: string,
	dependencies: QuizAnswerDependencies,
) {
	const logContext = {
		answerAttemptId,
		lessonId: input.lessonId,
		authoredQuestionId: input.questionId,
	}

	await dependencies.log.info('quiz.answer.received', {
		...logContext,
		answerCount: Array.isArray(input.answer) ? input.answer.length : 1,
	})

	let identity: QuizAnswerIdentity
	try {
		identity = await dependencies.resolveIdentity()
	} catch (error) {
		await dependencies.log.error('quiz.answer.identity.failed', {
			...logContext,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}

	let question: QuizAnswerQuestion | null
	try {
		question = await dependencies.findQuestion({
			lessonId: input.lessonId,
			authoredQuestionId: input.questionId,
		})
	} catch (error) {
		await dependencies.log.error('quiz.answer.resolve.failed', {
			...logContext,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}

	if (!question) {
		await dependencies.log.error('quiz.answer.resolve.failed', {
			...logContext,
			reason: 'question-not-found',
		})
		throw new QuizQuestionNotFoundError(input.lessonId, input.questionId)
	}

	await dependencies.log.info('quiz.answer.resolved', {
		...logContext,
		questionId: question.id,
		respondentKey: identity.respondentKey,
		userId: identity.userId,
		emailListSubscriberId: identity.emailListSubscriberId,
	})

	const correct = gradeAnswer(question.correct, input.answer)
	await dependencies.log.info('quiz.answer.graded', {
		...logContext,
		questionId: question.id,
		correct,
	})

	const now = dependencies.now()
	try {
		await dependencies.upsertResponse({
			id: dependencies.newId(),
			surveyId: input.lessonId,
			questionId: question.id,
			...identity,
			fields: { answer: input.answer, correct },
			createdAt: now,
			updatedAt: now,
		})
	} catch (error) {
		await dependencies.log.error('quiz.answer.save.failed', {
			...logContext,
			questionId: question.id,
			respondentKey: identity.respondentKey,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}

	await dependencies.log.info('quiz.answer.saved', {
		...logContext,
		questionId: question.id,
		respondentKey: identity.respondentKey,
		correct,
	})

	return {
		success: true as const,
		answerAttemptId,
		correct,
		questionId: question.id,
	}
}
