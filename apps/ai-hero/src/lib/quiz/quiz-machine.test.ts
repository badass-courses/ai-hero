import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'

// The published package's ESM bundle imports extensionless lodash modules that
// Node Vitest cannot resolve. Mirror only its verified submit state contract:
// rejected actor -> failure; resolved actor -> answered.correct/incorrect.
vi.mock('@coursebuilder/survey', async () => {
	const { assign, fromPromise, setup } = await import('xstate')
	const surveyMachine = setup({
		actors: {
			submitAnswer: fromPromise(async ({ input }: { input: any }) =>
				input.handleSubmitAnswer(input),
			),
		},
		guards: { answeredCorrectly: () => false },
	}).createMachine({
		initial: 'initializing',
		context: ({ input }: { input: any }) => ({ ...input, answer: '' }),
		states: {
			initializing: {
				on: {
					LOAD_QUESTION: {
						actions: assign({
							currentQuestion: ({ event }) => event.currentQuestion,
							currentQuestionId: ({ event }) => event.currentQuestionId,
						}),
						target: 'unanswered',
					},
				},
			},
			unanswered: {
				on: {
					ANSWER: {
						actions: assign({ answer: ({ event }) => event.answer }),
						target: 'answering',
					},
				},
			},
			answering: {
				invoke: {
					src: 'submitAnswer',
					input: ({ context }: { context: any }) => context,
					onDone: [
						{ target: 'answered.correct', guard: 'answeredCorrectly' },
						{ target: 'answered.incorrect' },
					],
					onError: { target: 'failure' },
				},
			},
			answered: {
				initial: 'incorrect',
				states: { correct: {}, incorrect: {} },
			},
			failure: {},
		},
	})
	return { surveyMachine }
})

import { bestEffortQuizPersistence, quizMachine } from './quiz-machine'

const question = {
	question: 'Which answer is correct?',
	type: 'multiple-choice' as const,
	choices: [
		{ answer: 'a', label: 'A' },
		{ answer: 'b', label: 'B' },
	],
	correct: 'a',
	answer: 'The explanation stays available.',
	shuffleChoices: false,
}

describe('best-effort quiz persistence', () => {
	it.each([
		{ answer: 'a', expectedState: 'answered.correct' },
		{ answer: 'b', expectedState: 'answered.incorrect' },
	])(
		'keeps feedback in $expectedState when persistence rejects',
		async ({ answer, expectedState }) => {
			const persistenceError = new Error('database unavailable')
			const persist = vi.fn().mockRejectedValue(persistenceError)
			const reportError = vi.fn()
			const handleSubmitAnswer = bestEffortQuizPersistence({
				persist,
				reportError,
			})
			const actor = createActor(quizMachine, {
				input: {
					currentQuestionId: 'question-1',
					currentQuestion: question,
					questionSet: { 'question-1': question },
					handleSubmitAnswer,
				},
			}).start()

			actor.send({
				type: 'LOAD_QUESTION',
				currentQuestionId: 'question-1',
				currentQuestion: question,
			})
			actor.send({ type: 'ANSWER', answer })

			await vi.waitFor(() => {
				expect(actor.getSnapshot().matches(expectedState)).toBe(true)
			})
			expect(actor.getSnapshot().context.currentQuestion.answer).toBe(
				'The explanation stays available.',
			)
			expect(persist).toHaveBeenCalledOnce()
			expect(reportError).toHaveBeenCalledWith(
				persistenceError,
				expect.objectContaining({ answer }),
			)
			expect(actor.getSnapshot().matches('failure')).toBe(false)
			actor.stop()
		},
	)
})
