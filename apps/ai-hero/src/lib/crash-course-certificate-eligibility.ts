import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
} from '@/db/schema'
import { AI_HERO_COURSE_SYNC_BINDING } from '@/course-sync/types'
import { quizRespondentKey } from '@/lib/quiz/answer'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
	MySqlDatabase,
	MySqlQueryResultHKT,
	PreparedQueryHKTBase,
} from 'drizzle-orm/mysql-core'
import { z } from 'zod'

const AuthenticatedUserIdSchema = z.string().trim().min(1)

const QuizQuestionFieldsSchema = z
	.object({
		required: z.boolean().optional(),
		courseSync: z.object({
			sourceQuestionId: z.string().trim().min(1),
		}),
	})
	.passthrough()

const QuizResponseFieldsSchema = z
	.object({
		correct: z.boolean(),
	})
	.passthrough()

export const AI_CODING_CRASH_COURSE_FINAL_QUIZ = {
	courseResourceId: AI_HERO_COURSE_SYNC_BINDING.anchorWorkshopId,
	bindingId: AI_HERO_COURSE_SYNC_BINDING.bindingId,
	sourceCourseId: AI_HERO_COURSE_SYNC_BINDING.sourceCourseId,
	sourceLessonId: 'ai-coding-crash-course-certificate-quiz-v1',
	targetLessonId: 'sync_lesson_800b577c51997b78aa74a65c',
	requiredSourceQuestionIds: [
		'agent-anatomy',
		'nondeterminism-permissions',
		'starting-context',
		'afk-review',
		'point-not-push',
		'prune-sediment',
		'massive-tasks',
		'reroute',
	],
} as const

type CrashCourseFinalQuizDefinition = typeof AI_CODING_CRASH_COURSE_FINAL_QUIZ

export type CrashCourseFinalQuizQuestionEvidence = {
	questionId: string
	sourceQuestionId: string | null
	required: boolean
}

export type CrashCourseFinalQuizEvidence = {
	lessonId: string
	questions: readonly CrashCourseFinalQuizQuestionEvidence[]
}

export type CrashCourseQuizResponseEvidence = {
	questionId: string
	correct: boolean
	updatedAt: Date
}

export type CrashCourseCertificateEvidenceRepository = {
	courseExists(definition: CrashCourseFinalQuizDefinition): Promise<boolean>
	findFinalQuiz(
		definition: CrashCourseFinalQuizDefinition,
	): Promise<CrashCourseFinalQuizEvidence | null>
	findResponses(input: {
		userId: string
		lessonId: string
		questionIds: readonly string[]
	}): Promise<readonly CrashCourseQuizResponseEvidence[]>
}

export type CrashCourseCertificateEligibility =
	| {
			eligible: true
			userId: string
			courseResourceId: string
			finalQuizLessonId: string
			completedAt: Date
			correctAnswers: number
			requiredAnswers: number
	  }
	| {
			eligible: false
			reason:
				| 'not-authenticated'
				| 'course-not-found'
				| 'final-quiz-not-configured'
				| 'final-quiz-empty'
				| 'final-quiz-question-set-mismatch'
	  }
	| {
			eligible: false
			reason: 'answers-missing' | 'answers-incorrect'
			correctAnswers: number
			requiredAnswers: number
	  }

type AppDatabaseSchema = typeof import('@/db/schema')

export function createDrizzleCrashCourseCertificateEvidenceRepository<
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQuery extends PreparedQueryHKTBase,
>(
	database: MySqlDatabase<TQueryResult, TPreparedQuery, AppDatabaseSchema>,
): CrashCourseCertificateEvidenceRepository {
	return {
		async courseExists(definition) {
			const course = await database.query.contentResource.findFirst({
				columns: { id: true },
				where: and(
					eq(contentResource.id, definition.courseResourceId),
					eq(contentResource.type, 'workshop'),
					isNull(contentResource.deletedAt),
				),
			})
			return Boolean(course)
		},

		async findFinalQuiz(definition) {
			const lesson = await database.query.contentResource.findFirst({
				columns: { id: true },
				where: and(
					eq(contentResource.id, definition.targetLessonId),
					eq(contentResource.type, 'lesson'),
					isNull(contentResource.deletedAt),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.courseSync.bindingId')) = ${definition.bindingId}`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.courseSync.sourceCourseId')) = ${definition.sourceCourseId}`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.courseSync.sourceLessonId')) = ${definition.sourceLessonId}`,
				),
			})
			if (!lesson) return null

			const parentSections =
				await database.query.contentResourceResource.findMany({
					where: and(
						eq(contentResourceResource.resourceId, lesson.id),
						isNull(contentResourceResource.deletedAt),
					),
					with: { resourceOf: true },
				})
			const activeSectionIds = parentSections
				.filter(
					(parent) =>
						parent.resourceOf.type === 'workshop' &&
						parent.resourceOf.deletedAt === null,
				)
				.map((parent) => parent.resourceOfId)
			if (activeSectionIds.length === 0) return null

			const courseRelation =
				await database.query.contentResourceResource.findFirst({
					columns: { resourceId: true },
					where: and(
						eq(
							contentResourceResource.resourceOfId,
							definition.courseResourceId,
						),
						inArray(contentResourceResource.resourceId, activeSectionIds),
						isNull(contentResourceResource.deletedAt),
					),
				})
			if (!courseRelation) return null

			const questionRelations =
				await database.query.contentResourceResource.findMany({
					where: and(
						eq(contentResourceResource.resourceOfId, lesson.id),
						isNull(contentResourceResource.deletedAt),
					),
					with: { resource: true },
				})

			return {
				lessonId: lesson.id,
				questions: questionRelations
					.filter(
						(relation) =>
							relation.resource.type === 'question' &&
							relation.resource.deletedAt === null,
					)
					.map((relation) => {
						const parsed = QuizQuestionFieldsSchema.safeParse(
							relation.resource.fields,
						)
						return {
							questionId: relation.resource.id,
							sourceQuestionId: parsed.success
								? parsed.data.courseSync.sourceQuestionId
								: null,
							required: parsed.success && parsed.data.required === true,
						}
					}),
			}
		},

		async findResponses({ userId, lessonId, questionIds }) {
			const rows = await database.query.questionResponse.findMany({
				columns: {
					questionId: true,
					fields: true,
					updatedAt: true,
				},
				where: and(
					eq(questionResponse.surveyId, lessonId),
					eq(questionResponse.userId, userId),
					eq(questionResponse.respondentKey, quizRespondentKey(userId)),
					inArray(questionResponse.questionId, [...questionIds]),
					isNull(questionResponse.deletedAt),
				),
			})

			return rows.flatMap((row) => {
				const fields = QuizResponseFieldsSchema.safeParse(row.fields)
				if (!fields.success || !row.updatedAt) return []
				return [
					{
						questionId: row.questionId,
						correct: fields.data.correct,
						updatedAt: row.updatedAt,
					},
				]
			})
		},
	}
}

const drizzleCrashCourseCertificateEvidenceRepository =
	createDrizzleCrashCourseCertificateEvidenceRepository(db)

export async function checkCrashCourseCertificateEligibility(
	input: { userId?: string | null },
	dependencies: {
		repository: CrashCourseCertificateEvidenceRepository
	} = { repository: drizzleCrashCourseCertificateEvidenceRepository },
): Promise<CrashCourseCertificateEligibility> {
	const parsedUserId = AuthenticatedUserIdSchema.safeParse(input.userId)
	if (!parsedUserId.success) {
		return { eligible: false, reason: 'not-authenticated' }
	}
	const userId = parsedUserId.data
	const definition = AI_CODING_CRASH_COURSE_FINAL_QUIZ

	if (!(await dependencies.repository.courseExists(definition))) {
		return { eligible: false, reason: 'course-not-found' }
	}

	const finalQuiz = await dependencies.repository.findFinalQuiz(definition)
	if (!finalQuiz) {
		return { eligible: false, reason: 'final-quiz-not-configured' }
	}
	if (finalQuiz.questions.length === 0) {
		return { eligible: false, reason: 'final-quiz-empty' }
	}

	const requiredQuestions = finalQuiz.questions.filter(
		(question) => question.required,
	)
	const approvedQuestionIds = new Set(definition.requiredSourceQuestionIds)
	const actualQuestionIds = new Set(
		requiredQuestions.map((question) => question.sourceQuestionId),
	)
	const questionSetMatches =
		requiredQuestions.length === approvedQuestionIds.size &&
		actualQuestionIds.size === approvedQuestionIds.size &&
		[...approvedQuestionIds].every((questionId) =>
			actualQuestionIds.has(questionId),
		)
	if (!questionSetMatches) {
		return {
			eligible: false,
			reason: 'final-quiz-question-set-mismatch',
		}
	}

	const responses = await dependencies.repository.findResponses({
		userId,
		lessonId: finalQuiz.lessonId,
		questionIds: requiredQuestions.map((question) => question.questionId),
	})
	const requiredTargetQuestionIds = new Set(
		requiredQuestions.map((question) => question.questionId),
	)
	const latestResponseByQuestion = new Map<
		string,
		CrashCourseQuizResponseEvidence
	>()
	for (const response of responses) {
		if (!requiredTargetQuestionIds.has(response.questionId)) continue
		const previous = latestResponseByQuestion.get(response.questionId)
		if (
			!previous ||
			response.updatedAt.getTime() > previous.updatedAt.getTime() ||
			(response.updatedAt.getTime() === previous.updatedAt.getTime() &&
				!response.correct)
		) {
			latestResponseByQuestion.set(response.questionId, response)
		}
	}

	const latestResponses = requiredQuestions
		.map((question) => latestResponseByQuestion.get(question.questionId))
		.filter(
			(response): response is CrashCourseQuizResponseEvidence =>
				response !== undefined,
		)
	const correctAnswers = latestResponses.filter(
		(response) => response.correct,
	).length
	const requiredAnswers = requiredQuestions.length

	if (latestResponses.length !== requiredAnswers) {
		return {
			eligible: false,
			reason: 'answers-missing',
			correctAnswers,
			requiredAnswers,
		}
	}
	if (correctAnswers !== requiredAnswers) {
		return {
			eligible: false,
			reason: 'answers-incorrect',
			correctAnswers,
			requiredAnswers,
		}
	}

	return {
		eligible: true,
		userId,
		courseResourceId: definition.courseResourceId,
		finalQuizLessonId: finalQuiz.lessonId,
		completedAt: new Date(
			Math.max(
				...latestResponses.map((response) => response.updatedAt.getTime()),
			),
		),
		correctAnswers,
		requiredAnswers,
	}
}
