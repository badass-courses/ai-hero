import { describe, expect, it, vi } from 'vitest'

import { persistSurveyAnswers } from './survey-answer-persistence'

const mocks = vi.hoisted(() => ({
	guid: vi.fn(),
}))

vi.mock('@coursebuilder/utils/guid', () => ({
	guid: mocks.guid,
}))

function testLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}
}

describe('persistSurveyAnswers', () => {
	it('retries QuestionResponse primary collisions with fresh IDs', async () => {
		mocks.guid
			.mockReturnValueOnce('firstid00001')
			.mockReturnValueOnce('secondid0002')
			.mockReturnValueOnce('thirdid00003')
		const primaryDuplicate = Object.assign(
			new Error("Duplicate entry 'abc12' for key 'PRIMARY'"),
			{ code: 'ER_DUP_ENTRY', errno: 1062 },
		)
		const insertValues = vi
			.fn()
			.mockRejectedValueOnce(primaryDuplicate)
			.mockRejectedValueOnce(primaryDuplicate)
			.mockResolvedValueOnce(undefined)
		const database = {
			query: {
				contentResource: {
					findFirst: vi.fn().mockResolvedValue({ id: 'survey-1' }),
					findMany: vi.fn().mockResolvedValue([
						{ id: 'question-1', fields: { slug: 'question-slug' } },
					]),
				},
			},
			insert: vi.fn(() => ({ values: insertValues })),
		}
		const logger = testLogger()

		await expect(
			persistSurveyAnswers({
				database,
				logger,
				surveySlug: 'survey-slug',
				answers: { 'question-slug': 'yes' },
				userId: 'user-1',
				emailListSubscriberId: null,
				eventPrefix: 'survey.answer',
			}),
		).resolves.toEqual({ answerCount: 1 })

		expect(insertValues).toHaveBeenCalledTimes(3)
		expect(insertValues.mock.calls.map(([records]) => records[0].id)).toEqual([
			'firstid00001',
			'secondid0002',
			'thirdid00003',
		])
		expect(logger.info).toHaveBeenCalledWith(
			'survey.answer.lookup',
			expect.objectContaining({
				questionSlug: 'question-slug',
				resolvedQuestionId: 'question-1',
				usedSurveySlugFallback: false,
				usedQuestionSlugFallback: false,
			}),
		)
		expect(logger.info).toHaveBeenCalledWith(
			'survey.answer.saved',
			expect.objectContaining({
				questionSlug: 'question-slug',
				questionId: 'question-1',
			}),
		)
	})

	it('treats empty answers as a no-op without querying invalid SQL', async () => {
		const database = {
			query: {
				contentResource: {
					findFirst: vi.fn(),
					findMany: vi.fn(),
				},
			},
			insert: vi.fn(),
		}
		const logger = testLogger()

		await expect(
			persistSurveyAnswers({
				database,
				logger,
				surveySlug: 'welcome',
				answers: {},
				userId: null,
				emailListSubscriberId: null,
			}),
		).resolves.toEqual({ answerCount: 0 })

		expect(database.query.contentResource.findFirst).not.toHaveBeenCalled()
		expect(database.query.contentResource.findMany).not.toHaveBeenCalled()
		expect(database.insert).not.toHaveBeenCalled()
		expect(logger.error).not.toHaveBeenCalled()
		expect(logger.info).toHaveBeenCalledWith(
			'survey.answers.skipped.empty',
			expect.objectContaining({ surveySlug: 'welcome' }),
		)
	})
})
