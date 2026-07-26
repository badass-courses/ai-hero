import { describe, expect, it, vi } from 'vitest'

import {
	getOrCreateQuizSessionId,
	quizRespondentKey,
	QuizAnswerInputSchema,
	QuizQuestionNotFoundError,
	submitQuizAnswer,
	type QuizAnswerIdentity,
	type QuizAnswerRecord,
} from './answer'

const identity: QuizAnswerIdentity = {
	respondentKey: 'session:anon-session-1',
	surveySessionId: 'anon-session-1',
	userId: null,
	emailListSubscriberId: null,
}

function createHarness(correct: string | string[] = 'a') {
	const responses = new Map<string, QuizAnswerRecord>()
	const events: string[] = []
	let id = 0
	const dependencies = {
		resolveIdentity: vi.fn(async () => identity),
		findQuestion: vi.fn(async () => ({
			id: 'sync_question_abc123',
			correct,
		})),
		upsertResponse: vi.fn(async (record: QuizAnswerRecord) => {
			const key = [record.surveyId, record.questionId, record.respondentKey].join(':')
			const previous = responses.get(key)
			responses.set(key, previous ? { ...record, id: previous.id } : record)
		}),
		newId: () => `response-${++id}`,
		now: () => new Date('2026-07-25T00:00:00.000Z'),
		log: {
			info: async (event: string) => events.push(event),
			error: async (event: string) => events.push(event),
		},
	}
	return { dependencies, events, responses }
}

describe('submitQuizAnswer', () => {
	it('upserts the same respondent and question instead of adding a retry row', async () => {
		const harness = createHarness('a')

		await submitQuizAnswer(
			{ lessonId: 'lesson-1', questionId: 'authored-1', answer: 'b' },
			'attempt-1',
			harness.dependencies,
		)
		await submitQuizAnswer(
			{ lessonId: 'lesson-1', questionId: 'authored-1', answer: 'a' },
			'attempt-2',
			harness.dependencies,
		)

		expect(harness.responses.size).toBe(1)
		expect([...harness.responses.values()][0]).toMatchObject({
			id: 'response-1',
			respondentKey: 'session:anon-session-1',
			fields: { answer: 'a', correct: true },
		})
	})

	it('grades a single answer from the resolved question row', async () => {
		const harness = createHarness('correct-choice')

		const result = await submitQuizAnswer(
			{
				lessonId: 'lesson-1',
				questionId: 'authored-1',
				answer: 'wrong-choice',
			},
			'attempt-single',
			harness.dependencies,
		)

		expect(result.correct).toBe(false)
		expect([...harness.responses.values()][0]?.fields.correct).toBe(false)
		expect(harness.events).toEqual([
			'quiz.answer.received',
			'quiz.answer.resolved',
			'quiz.answer.graded',
			'quiz.answer.saved',
		])
	})

	it('grades multi-select as an exact set', async () => {
		const partial = createHarness(['a', 'b'])
		const exact = createHarness(['a', 'b'])

		const partialResult = await submitQuizAnswer(
			{ lessonId: 'lesson-1', questionId: 'authored-1', answer: ['a'] },
			'attempt-partial',
			partial.dependencies,
		)
		const exactResult = await submitQuizAnswer(
			{ lessonId: 'lesson-1', questionId: 'authored-1', answer: ['b', 'a'] },
			'attempt-exact',
			exact.dependencies,
		)

		expect(partialResult.correct).toBe(false)
		expect(exactResult.correct).toBe(true)
	})

	it('rejects an authored question id that has no synced row', async () => {
		const harness = createHarness()

		await expect(
			submitQuizAnswer(
				{ lessonId: 'lesson-1', questionId: 'missing', answer: 'a' },
				'attempt-missing',
				{ ...harness.dependencies, findQuestion: async () => null },
			),
		).rejects.toBeInstanceOf(QuizQuestionNotFoundError)
		expect(harness.dependencies.upsertResponse).not.toHaveBeenCalled()
		expect(harness.events).toContain('quiz.answer.resolve.failed')
	})

	it('ignores a client-supplied correct value and grades from the row', async () => {
		const input = QuizAnswerInputSchema.parse({
			lessonId: 'lesson-1',
			questionId: 'authored-1',
			answer: 'a',
			correct: false,
		})
		const harness = createHarness('a')

		const result = await submitQuizAnswer(
			input,
			'attempt-untrusted-correct',
			harness.dependencies,
		)

		expect(input).not.toHaveProperty('correct')
		expect(result.correct).toBe(true)
	})

	it('keeps one row for the same user across browser sessions', async () => {
		const harness = createHarness('a')
		harness.dependencies.resolveIdentity
			.mockResolvedValueOnce({
				respondentKey: quizRespondentKey('user-1', 'browser-1'),
				surveySessionId: 'browser-1',
				userId: 'user-1',
				emailListSubscriberId: null,
			})
			.mockResolvedValueOnce({
				respondentKey: quizRespondentKey('user-1', 'browser-2'),
				surveySessionId: 'browser-2',
				userId: 'user-1',
				emailListSubscriberId: null,
			})

		await submitQuizAnswer(
			{ lessonId: 'lesson-1', questionId: 'authored-1', answer: 'b' },
			'attempt-browser-1',
			harness.dependencies,
		)
		await submitQuizAnswer(
			{ lessonId: 'lesson-1', questionId: 'authored-1', answer: 'a' },
			'attempt-browser-2',
			harness.dependencies,
		)

		expect(harness.responses.size).toBe(1)
		expect([...harness.responses.values()][0]).toMatchObject({
			respondentKey: 'user:user-1',
			surveySessionId: 'browser-2',
			fields: { answer: 'a', correct: true },
		})
	})
})

describe('getOrCreateQuizSessionId', () => {
	it('mints one anonymous respondent key and reuses it', () => {
		const values = new Map<string, string>()
		const set = vi.fn((name: string, value: string) => values.set(name, value))
		const cookieStore = {
			get: (name: string) => {
				const value = values.get(name)
				return value ? { value } : undefined
			},
			set,
		}
		const newId = vi.fn(() => 'stable-anonymous-id')

		const first = getOrCreateQuizSessionId(cookieStore, 'quiz-session', newId)
		const second = getOrCreateQuizSessionId(cookieStore, 'quiz-session', newId)

		expect(first).toBe('stable-anonymous-id')
		expect(second).toBe(first)
		expect(newId).toHaveBeenCalledTimes(1)
		expect(set).toHaveBeenCalledTimes(1)
		expect(quizRespondentKey(null, first)).toBe(
			'session:stable-anonymous-id',
		)
	})
})
