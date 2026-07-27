import { QuestionResourceSchema } from '@coursebuilder/survey/types'
import { z } from 'zod'

export const QuizQuestionDataSchema = QuestionResourceSchema.extend({
	id: z.string().trim().min(1).optional(),
	question: z.string().trim().min(1),
	type: z.literal('multiple-choice'),
	choices: z
		.array(
			z.object({
				answer: z.string().trim().min(1),
				label: z.string().optional(),
				image: z.string().optional(),
			}),
		)
		.min(2),
	correct: z.union([
		z.string().trim().min(1),
		z.array(z.string().trim().min(1)).min(1),
	]),
	answer: z.string().trim().min(1),
}).superRefine((question, context) => {
	const choiceAnswers = question.choices.map((choice) => choice.answer)
	const uniqueChoiceAnswers = new Set(choiceAnswers)

	if (uniqueChoiceAnswers.size !== choiceAnswers.length) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['choices'],
			message: 'Choice answers must be unique.',
		})
	}

	const correctAnswers = Array.isArray(question.correct)
		? question.correct
		: [question.correct]
	if (new Set(correctAnswers).size !== correctAnswers.length) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['correct'],
			message: 'Correct answers must be unique.',
		})
	}

	const missingCorrectAnswers = correctAnswers.filter(
		(correctAnswer) => !uniqueChoiceAnswers.has(correctAnswer),
	)

	if (missingCorrectAnswers.length > 0) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['correct'],
			message: 'Every correct answer must match a choice answer.',
		})
	}
})

export type QuizQuestionData = z.infer<typeof QuizQuestionDataSchema>
