import { surveyMachine } from '@coursebuilder/survey'

import { gradeAnswer } from './grade-answer'

export const quizMachine = surveyMachine.provide({
	guards: {
		answeredCorrectly: ({ context }) => {
			const correct = context.currentQuestion.correct
			return correct !== undefined && gradeAnswer(correct, context.answer)
		},
	},
})

type PersistenceInput = {
	answer: string | string[]
}

/**
 * Quiz persistence is telemetry, not the teaching interaction's gate. The
 * survey machine sends a rejected submit actor to its terminal failure state,
 * so this adapter must consume persistence errors after reporting them.
 */
export function bestEffortQuizPersistence({
	persist,
	reportError,
}: {
	persist(input: PersistenceInput): Promise<unknown>
	reportError(error: unknown, input: PersistenceInput): void
}) {
	return async (input: PersistenceInput) => {
		try {
			await persist(input)
		} catch (error) {
			try {
				reportError(error, input)
			} catch {
				// Telemetry must not become a second path into the machine's dead-end
				// failure state.
			}
		}
	}
}
