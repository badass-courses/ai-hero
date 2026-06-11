import { assign, setup } from 'xstate'

export type CheckoutSurveyAnswer = {
	value: string
	label: string
}

export type CheckoutSurveyMachineContext = {
	selectedAnswer: CheckoutSurveyAnswer | null
	lastSaveError: string | null
	saveAnswer: (answer: CheckoutSurveyAnswer) => void | Promise<unknown>
}

export const checkoutSurveyMachine = setup({
	types: {
		context: {} as CheckoutSurveyMachineContext,
		input: {} as {
			saveAnswer: (answer: CheckoutSurveyAnswer) => void | Promise<unknown>
		},
		events: {} as
			| { type: 'BUY_CLICKED' }
			| { type: 'ANSWER_SELECTED'; answer: CheckoutSurveyAnswer }
			| { type: 'CHANGE_ANSWER_CLICKED' }
			| { type: 'CONTINUE_CLICKED' }
			| { type: 'SURVEY_SAVE_FAILED'; error: string }
			| { type: 'STRIPE_REDIRECT_STARTED' },
	},
	actions: {
		storeAnswer: assign({
			selectedAnswer: ({ event }) => {
				if (event.type !== 'ANSWER_SELECTED') return null
				return event.answer
			},
			lastSaveError: () => null,
		}),
		clearAnswer: assign({
			selectedAnswer: () => null,
			lastSaveError: () => null,
		}),
		saveAnswerIfPresent: ({ context, self }) => {
			if (!context.selectedAnswer) return
			try {
				const result = context.saveAnswer(context.selectedAnswer)
				if (
					result &&
					typeof (result as Promise<unknown>).catch === 'function'
				) {
					;(result as Promise<unknown>).catch((error) => {
						self.send({
							type: 'SURVEY_SAVE_FAILED',
							error: error instanceof Error ? error.message : String(error),
						})
					})
				}
			} catch (error) {
				self.send({
					type: 'SURVEY_SAVE_FAILED',
					error: error instanceof Error ? error.message : String(error),
				})
			}
		},
		rememberSaveFailure: assign({
			lastSaveError: ({ event }) => {
				if (event.type !== 'SURVEY_SAVE_FAILED') return null
				return event.error
			},
		}),
	},
}).createMachine({
	id: 'aiHeroCheckoutSurvey',
	context: ({ input }) => ({
		selectedAnswer: null,
		lastSaveError: null,
		saveAnswer: input.saveAnswer,
	}),
	initial: 'idle',
	states: {
		idle: {
			on: {
				BUY_CLICKED: { target: 'asking' },
			},
		},
		asking: {
			on: {
				ANSWER_SELECTED: { target: 'answered', actions: ['storeAnswer'] },
				CONTINUE_CLICKED: { target: 'redirecting' },
			},
		},
		answered: {
			on: {
				CHANGE_ANSWER_CLICKED: { target: 'asking', actions: ['clearAnswer'] },
				CONTINUE_CLICKED: {
					target: 'submitting',
					actions: ['saveAnswerIfPresent'],
				},
			},
		},
		submitting: {
			always: { target: 'redirecting' },
		},
		redirecting: {
			on: {
				STRIPE_REDIRECT_STARTED: { target: 'redirecting' },
				SURVEY_SAVE_FAILED: {
					target: 'failedSurveySaveButContinuing',
					actions: ['rememberSaveFailure'],
				},
			},
		},
		failedSurveySaveButContinuing: {
			on: {
				STRIPE_REDIRECT_STARTED: { target: 'failedSurveySaveButContinuing' },
			},
		},
	},
})
