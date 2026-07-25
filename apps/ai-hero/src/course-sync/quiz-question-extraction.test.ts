import { describe, expect, it } from 'vitest'

import { targetResourceId } from './control-plane'
import { extractQuizQuestions } from './quiz-question-extraction'

const lessonId = 'lesson-inline-quizzes'

describe('quiz question extraction', () => {
	it('extracts static MDX object literals in document order', () => {
		const body = `
# Quiz

<Quiz>
  <QuizQuestion data={{
    id: 'single-choice',
    question: 'Which value?',
    type: 'multiple-choice',
    choices: [
      { answer: 'a', label: 'A' },
      { answer: 'b', label: 'B', image: '/b.png' },
    ],
    correct: 'b',
    answer: 'B is the value.',
    required: true,
  }} />
  <QuizQuestion data={{
    id: 'multi-choice',
    question: 'Choose both',
    type: 'multiple-choice',
    choices: [{ answer: 'a' }, { answer: 'b' }, { answer: 'c' }],
    correct: ['a', 'c'],
    answer: 'A and C are correct.',
    allowMultiple: true,
    shuffleChoices: false,
  }} />
</Quiz>
`

		expect(extractQuizQuestions(body, lessonId)).toEqual([
			{
				id: 'single-choice',
				position: 0,
				fields: {
					question: 'Which value?',
					type: 'multiple-choice',
					choices: [
						{ answer: 'a', label: 'A' },
						{ answer: 'b', label: 'B', image: '/b.png' },
					],
					correct: 'b',
					answer: 'B is the value.',
					required: true,
				},
			},
			{
				id: 'multi-choice',
				position: 1,
				fields: {
					question: 'Choose both',
					type: 'multiple-choice',
					choices: [{ answer: 'a' }, { answer: 'b' }, { answer: 'c' }],
					correct: ['a', 'c'],
					answer: 'A and C are correct.',
					allowMultiple: true,
					shuffleChoices: false,
				},
			},
		])
	})

	it('derives stable ids from the authored id, not question text', () => {
		const first = targetResourceId('binding', 'question', 'stable-id')
		const afterRewording = targetResourceId('binding', 'question', 'stable-id')
		expect(first).toBe(afterRewording)
		expect(first).toBe('sync_question_f5b4ec134c31bb05c3a4546f')
		expect(targetResourceId('binding', 'question', 'another-id')).not.toBe(first)
	})

	it('fails loudly when an id is missing', () => {
		expect(() =>
			extractQuizQuestions(
				`<QuizQuestion data={{ question: 'No id', type: 'essay' }} />`,
				lessonId,
			),
		).toThrow(`Lesson ${lessonId} has invalid QuizQuestion id <missing>: id is required`)
	})

	it('fails loudly when an id is duplicated within a lesson', () => {
		const body = `
<QuizQuestion data={{ id: 'same', question: 'One', type: 'essay' }} />
<QuizQuestion data={{ id: 'same', question: 'Two', type: 'essay' }} />
`
		expect(() => extractQuizQuestions(body, lessonId)).toThrow(
			`Lesson ${lessonId} has invalid QuizQuestion id same: id is duplicated in this lesson`,
		)
	})

	it('rejects dynamic data instead of evaluating lesson code', () => {
		expect(() =>
			extractQuizQuestions(
				`<QuizQuestion data={{ id: questionId, question: 'Dynamic', type: 'essay' }} />`,
				lessonId,
			),
		).toThrow('dynamic expression Identifier is not supported')
	})
})
