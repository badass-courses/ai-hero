import {
	surveyMachine,
	type SurveyMachineContext,
} from '@coursebuilder/survey'

import { gradeAnswer } from './grade-answer'

export type QuizPersistenceTarget = {
	lessonId: string
	questionId: string
}

export type QuizPersistenceRequest = QuizPersistenceTarget & {
	answer: string | string[]
}

export const quizMachine = surveyMachine.provide({
	guards: {
		answeredCorrectly: ({ context }) => {
			const correct = context.currentQuestion.correct
			return correct !== undefined && gradeAnswer(correct, context.answer)
		},
	},
})

/**
 * Start persistence from the machine's live question context, then resolve the
 * submit actor immediately. The learner gets feedback without waiting for the
 * database. Rejections still reach telemetry but never the machine's
 * terminal failure state.
 */
export function createBestEffortQuizPersistence({
	persist,
	reportError,
}: {
	persist(input: QuizPersistenceRequest): Promise<unknown>
	reportError(error: unknown, input: QuizPersistenceRequest): void
}) {
	const reportSafely = (error: unknown, input: QuizPersistenceRequest) => {
		try {
			reportError(error, input)
		} catch {
			// Telemetry must not become a second path into the machine's dead-end
			// failure state.
		}
	}

	return (input: SurveyMachineContext) => {
		const target = (
			input.currentQuestion as SurveyMachineContext['currentQuestion'] & {
				persistence?: QuizPersistenceTarget
			}
		).persistence
		if (!target) return Promise.resolve()

		const request = { ...target, answer: input.answer }
		try {
			void persist(request).catch((error) => reportSafely(error, request))
		} catch (error) {
			reportSafely(error, request)
		}
		return Promise.resolve()
	}
}
