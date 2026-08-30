import { targetResourceId } from '@/course-sync/control-plane'
import { describe, expect, it, vi } from 'vitest'

import {
	AI_CODING_CRASH_COURSE_FINAL_QUIZ,
	checkCrashCourseCertificateEligibility,
	type CrashCourseCertificateEvidenceRepository,
	type CrashCourseFinalQuizEvidence,
	type CrashCourseQuizResponseEvidence,
} from './crash-course-certificate-eligibility'

const requiredQuestions =
	AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredSourceQuestionIds.map(
		(sourceQuestionId) => ({
			questionId: `question-${sourceQuestionId}`,
			sourceQuestionId,
			required: true,
		}),
	)

const finalQuiz: CrashCourseFinalQuizEvidence = {
	lessonId: 'lesson-final-quiz',
	questions: requiredQuestions,
}

function responses(
	correct = true,
	updatedAt = new Date('2026-08-30T12:00:00.000Z'),
): CrashCourseQuizResponseEvidence[] {
	return requiredQuestions.map((question, index) => ({
		questionId: question.questionId,
		correct,
		updatedAt: new Date(updatedAt.getTime() + index * 1_000),
	}))
}

function repository(
	overrides: Partial<CrashCourseCertificateEvidenceRepository> = {},
): CrashCourseCertificateEvidenceRepository {
	return {
		courseExists: vi.fn().mockResolvedValue(true),
		findFinalQuiz: vi.fn().mockResolvedValue(finalQuiz),
		findResponses: vi.fn().mockResolvedValue(responses()),
		...overrides,
	}
}

describe('Crash Course certificate eligibility', () => {
	it('pins the server-owned Course Sync lesson identity', () => {
		expect(
			targetResourceId(
				AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
				'lesson',
				AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
			),
		).toBe(AI_CODING_CRASH_COURSE_FINAL_QUIZ.targetLessonId)
	})

	it('fails before database reads when no authenticated user is present', async () => {
		const evidence = repository()

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: null },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'not-authenticated',
		})
		expect(evidence.courseExists).not.toHaveBeenCalled()
		expect(evidence.findFinalQuiz).not.toHaveBeenCalled()
		expect(evidence.findResponses).not.toHaveBeenCalled()
	})

	it('fails closed when the Crash Course resource is missing', async () => {
		const evidence = repository({
			courseExists: vi.fn().mockResolvedValue(false),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'course-not-found',
		})
		expect(evidence.findFinalQuiz).not.toHaveBeenCalled()
	})

	it('fails closed when the server-owned final quiz binding is missing', async () => {
		const evidence = repository({
			findFinalQuiz: vi.fn().mockResolvedValue(null),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'final-quiz-not-configured',
		})
		expect(evidence.findResponses).not.toHaveBeenCalled()
	})

	it('fails closed when the final quiz has no active questions', async () => {
		const evidence = repository({
			findFinalQuiz: vi.fn().mockResolvedValue({
				lessonId: 'lesson-final-quiz',
				questions: [],
			}),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'final-quiz-empty',
		})
	})

	it('fails closed when active required questions differ from the approved set', async () => {
		const evidence = repository({
			findFinalQuiz: vi.fn().mockResolvedValue({
				lessonId: 'lesson-final-quiz',
				questions: [
					...requiredQuestions.slice(0, -1),
					{
						questionId: 'question-unapproved',
						sourceQuestionId: 'unapproved',
						required: true,
					},
				],
			}),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'final-quiz-question-set-mismatch',
		})
	})

	it('ignores unrelated and optional quiz questions', async () => {
		const evidence = repository({
			findFinalQuiz: vi.fn().mockResolvedValue({
				lessonId: 'lesson-final-quiz',
				questions: [
					...requiredQuestions,
					{
						questionId: 'question-optional',
						sourceQuestionId: 'spec-vs-ticket',
						required: false,
					},
				],
			}),
			findResponses: vi.fn().mockResolvedValue([
				...responses(),
				{
					questionId: 'question-unrelated',
					correct: false,
					updatedAt: new Date('2026-08-31T00:00:00.000Z'),
				},
			]),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toMatchObject({
			eligible: true,
			correctAnswers: 8,
			requiredAnswers: 8,
		})
	})

	it('denies eligibility when any required answer is missing', async () => {
		const evidence = repository({
			findResponses: vi.fn().mockResolvedValue(responses().slice(0, -1)),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'answers-missing',
			correctAnswers: 7,
			requiredAnswers: 8,
		})
	})

	it('denies eligibility when the latest required answer is incorrect', async () => {
		const answerRows = responses()
		answerRows[3] = { ...answerRows[3]!, correct: false }
		const evidence = repository({
			findResponses: vi.fn().mockResolvedValue(answerRows),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: false,
			reason: 'answers-incorrect',
			correctAnswers: 7,
			requiredAnswers: 8,
		})
	})

	it('uses the latest saved response when a learner retries incorrectly', async () => {
		const answerRows = responses()
		answerRows.push({
			questionId: requiredQuestions[0]!.questionId,
			correct: false,
			updatedAt: new Date('2026-08-31T00:00:00.000Z'),
		})
		const evidence = repository({
			findResponses: vi.fn().mockResolvedValue(answerRows),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toMatchObject({
			eligible: false,
			reason: 'answers-incorrect',
			correctAnswers: 7,
		})
	})

	it('allows a later correct retry to make the learner eligible', async () => {
		const answerRows = responses()
		answerRows[0] = { ...answerRows[0]!, correct: false }
		answerRows.push({
			questionId: requiredQuestions[0]!.questionId,
			correct: true,
			updatedAt: new Date('2026-08-31T00:00:00.000Z'),
		})
		const evidence = repository({
			findResponses: vi.fn().mockResolvedValue(answerRows),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toMatchObject({
			eligible: true,
			completedAt: new Date('2026-08-31T00:00:00.000Z'),
			correctAnswers: 8,
			requiredAnswers: 8,
		})
	})

	it('returns the latest qualifying answer timestamp as the certificate date', async () => {
		const answerRows = responses(true, new Date('2026-08-30T18:00:00.000Z'))
		const evidence = repository({
			findResponses: vi.fn().mockResolvedValue(answerRows),
		})

		await expect(
			checkCrashCourseCertificateEligibility(
				{ userId: 'user-1' },
				{ repository: evidence },
			),
		).resolves.toEqual({
			eligible: true,
			userId: 'user-1',
			courseResourceId: 'workshop-2ozd9',
			finalQuizLessonId: 'lesson-final-quiz',
			completedAt: new Date('2026-08-30T18:00:07.000Z'),
			correctAnswers: 8,
			requiredAnswers: 8,
		})
	})
})
