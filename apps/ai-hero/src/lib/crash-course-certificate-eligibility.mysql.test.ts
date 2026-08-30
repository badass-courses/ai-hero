import { randomUUID } from 'node:crypto'

import * as schema from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
	AI_CODING_CRASH_COURSE_FINAL_QUIZ,
	checkCrashCourseCertificateEligibility,
	createDrizzleCrashCourseCertificateEvidenceRepository,
} from './crash-course-certificate-eligibility'
import { validateMySqlIntegrationServerUrl } from './team-purchase-mysql-test-guard'

const mysqlServerUrl = process.env.AIH_COURSE_CERTIFICATE_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const userId = 'user-certificate-mysql'
const lessonId = AI_CODING_CRASH_COURSE_FINAL_QUIZ.targetLessonId
const sectionId = 'section-certificate-final'
const now = new Date('2026-08-30T12:00:00.000Z')
const invalidLineageScenarios = [
	{
		name: 'binding',
		courseSync: {
			bindingId: 'wrong-binding',
			sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
			sourceLessonId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
		},
	},
	{
		name: 'source course',
		courseSync: {
			bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
			sourceCourseId: 'wrong-course',
			sourceLessonId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
		},
	},
	{
		name: 'source lesson',
		courseSync: {
			bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
			sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
			sourceLessonId: 'wrong-lesson',
		},
	},
] as const

type IntegrationDatabase = ReturnType<typeof createIntegrationDatabase>

const ddl = `
CREATE TABLE AI_ContentResource (
  id varchar(255) NOT NULL PRIMARY KEY,
  organizationId varchar(191) NULL,
  createdByOrganizationMembershipId varchar(191) NULL,
  type varchar(255) NOT NULL,
  createdById varchar(255) NOT NULL,
  fields json NULL,
  slug varchar(255) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug'))) STORED,
  currentVersionId varchar(255) NULL,
  createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  deletedAt timestamp(3) NULL,
  INDEX type_idx (type),
  INDEX slug_idx (slug)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE AI_ContentResourceResource (
  resourceOfId varchar(255) NOT NULL,
  resourceId varchar(255) NOT NULL,
  position double NOT NULL DEFAULT 0,
  metadata json NULL,
  organizationId varchar(191) NULL,
  createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  deletedAt timestamp(3) NULL,
  PRIMARY KEY (resourceOfId, resourceId),
  INDEX contentResourceId_idx (resourceOfId),
  INDEX resourceId_idx (resourceId)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE AI_QuestionResponse (
  id varchar(255) NOT NULL PRIMARY KEY,
  surveyId varchar(255) NOT NULL,
  questionId varchar(255) NOT NULL,
  respondentKey varchar(255) NULL,
  surveySessionId varchar(255) NULL,
  userId varchar(255) NULL,
  emailListSubscriberId varchar(255) NULL,
  fields json NULL,
  createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  deletedAt timestamp(3) NULL,
  UNIQUE KEY survey_question_respondent_unique (surveyId, questionId, respondentKey),
  INDEX surveyId_idx (surveyId),
  INDEX questionId_idx (questionId),
  INDEX respondent_key_idx (respondentKey),
  INDEX userId_idx (userId)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
`

integration('Crash Course certificate MySQL evidence query', () => {
	let serverPool: Pool
	let databasePool: Pool
	let queryPool: Pool
	let databaseName: string
	let database: IntegrationDatabase

	beforeAll(async () => {
		const safeServerUrl = validateMySqlIntegrationServerUrl(mysqlServerUrl!, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		serverPool = mysql.createPool({
			uri: safeServerUrl.toString(),
			connectionLimit: 1,
			timezone: 'Z',
		})
		databaseName = `aih_course_certificate_test_${randomUUID().replaceAll('-', '')}`
		await serverPool.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const databaseUrl = new URL(safeServerUrl)
		databaseUrl.pathname = `/${databaseName}`
		databasePool = mysql.createPool({
			uri: databaseUrl.toString(),
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		await databasePool.query(ddl)
		queryPool = mysql.createPool({
			uri: databaseUrl.toString(),
			connectionLimit: 1,
			timezone: 'Z',
		})
		database = createIntegrationDatabase(queryPool)
	})

	beforeEach(async () => {
		await databasePool.query('DELETE FROM AI_QuestionResponse')
		await databasePool.query('DELETE FROM AI_ContentResourceResource')
		await databasePool.query('DELETE FROM AI_ContentResource')
		await seedCourseShell(database)
	})

	afterAll(async () => {
		await queryPool.end()
		await databasePool.end()
		await serverPool.query(`DROP DATABASE \`${databaseName}\``)
		await serverPool.end()
	})

	it('fails closed while the server-owned final quiz lesson is absent', async () => {
		const result = await checkCrashCourseCertificateEligibility(
			{ userId },
			{
				repository:
					createDrizzleCrashCourseCertificateEvidenceRepository(database),
			},
		)

		expect(result).toEqual({
			eligible: false,
			reason: 'final-quiz-not-configured',
		})
	})

	it('ignores a lookalike lesson that does not own the pinned target ID', async () => {
		await database.insert(schema.contentResource).values(
			resource('lesson-certificate-lookalike', 'lesson', {
				title: 'Lookalike Certificate Checkpoint',
				courseSync: {
					bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
					sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
					sourceLessonId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
				},
			}),
		)
		await database.insert(schema.contentResourceResource).values({
			resourceOfId: sectionId,
			resourceId: 'lesson-certificate-lookalike',
			position: 1,
		})

		const result = await checkCrashCourseCertificateEligibility(
			{ userId },
			{
				repository:
					createDrizzleCrashCourseCertificateEvidenceRepository(database),
			},
		)

		expect(result).toEqual({
			eligible: false,
			reason: 'final-quiz-not-configured',
		})
	})

	it('rejects a required question with a lookalike target ID', async () => {
		await seedFinalQuiz(database)
		const firstQuestion = AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredQuestions[0]
		await database
			.delete(schema.contentResourceResource)
			.where(
				and(
					eq(schema.contentResourceResource.resourceOfId, lessonId),
					eq(
						schema.contentResourceResource.resourceId,
						firstQuestion.targetQuestionId,
					),
				),
			)
		await database.insert(schema.contentResource).values(
			resource('question-lookalike', 'question', {
				required: true,
				courseSync: {
					bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
					sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
					sourceLessonId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
					sourceQuestionId: firstQuestion.sourceQuestionId,
				},
			}),
		)
		await database.insert(schema.contentResourceResource).values({
			resourceOfId: lessonId,
			resourceId: 'question-lookalike',
			position: 0,
		})

		const result = await checkCrashCourseCertificateEligibility(
			{ userId },
			{
				repository:
					createDrizzleCrashCourseCertificateEvidenceRepository(database),
			},
		)

		expect(result).toEqual({
			eligible: false,
			reason: 'final-quiz-question-set-mismatch',
		})
	})

	it.each(invalidLineageScenarios)(
		'rejects a required question with the wrong $name lineage',
		async (scenario) => {
			await seedFinalQuiz(database)
			const firstQuestion =
				AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredQuestions[0]
			await database
				.update(schema.contentResource)
				.set({
					fields: {
						required: true,
						courseSync: {
							...scenario.courseSync,
							sourceQuestionId: firstQuestion.sourceQuestionId,
						},
					},
				})
				.where(eq(schema.contentResource.id, firstQuestion.targetQuestionId))

			const result = await checkCrashCourseCertificateEligibility(
				{ userId },
				{
					repository:
						createDrizzleCrashCourseCertificateEvidenceRepository(database),
				},
			)

			expect(result).toEqual({
				eligible: false,
				reason: 'final-quiz-question-set-mismatch',
			})
		},
	)

	it('reads the related final quiz and latest authenticated answers', async () => {
		await seedFinalQuiz(database)
		await seedResponses(database)

		const result = await checkCrashCourseCertificateEligibility(
			{ userId },
			{
				repository:
					createDrizzleCrashCourseCertificateEvidenceRepository(database),
			},
		)

		expect(result).toEqual({
			eligible: true,
			userId,
			courseResourceId: 'workshop-2ozd9',
			finalQuizLessonId: lessonId,
			completedAt: new Date('2026-08-30T12:00:07.000Z'),
			correctAnswers: 8,
			requiredAnswers: 8,
		})
	})

	it('denies eligibility after the latest saved answer becomes incorrect', async () => {
		await seedFinalQuiz(database)
		await seedResponses(database)
		const firstQuestionId =
			AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredQuestions[0].targetQuestionId
		await database
			.update(schema.questionResponse)
			.set({
				fields: { answer: 'wrong', correct: false },
				updatedAt: new Date('2026-08-31T00:00:00.000Z'),
			})
			.where(
				and(
					eq(schema.questionResponse.surveyId, lessonId),
					eq(schema.questionResponse.questionId, firstQuestionId),
				),
			)

		const result = await checkCrashCourseCertificateEligibility(
			{ userId },
			{
				repository:
					createDrizzleCrashCourseCertificateEvidenceRepository(database),
			},
		)

		expect(result).toEqual({
			eligible: false,
			reason: 'answers-incorrect',
			correctAnswers: 7,
			requiredAnswers: 8,
		})
	})
})

function createIntegrationDatabase(pool: Pool) {
	return drizzle(pool, {
		schema,
		mode: 'planetscale',
	})
}

async function seedCourseShell(database: IntegrationDatabase) {
	await database.insert(schema.contentResource).values([
		resource('workshop-2ozd9', 'workshop', {
			title: 'AI Coding Crash Course',
			slug: 'ai-coding-crash-course',
		}),
		resource(sectionId, 'workshop', {
			title: 'Certificate',
			courseSync: {
				bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
				sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
				sourceSectionId: 'certificate-section',
			},
		}),
	])
	await database.insert(schema.contentResourceResource).values({
		resourceOfId: 'workshop-2ozd9',
		resourceId: sectionId,
		position: 0,
	})
}

async function seedFinalQuiz(database: IntegrationDatabase) {
	await database.insert(schema.contentResource).values([
		resource(lessonId, 'lesson', {
			title: 'Certificate Checkpoint',
			courseSync: {
				bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
				sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
				sourceLessonId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
			},
		}),
		...AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredQuestions.map((question) =>
			resource(question.targetQuestionId, 'question', {
				required: true,
				courseSync: {
					bindingId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.bindingId,
					sourceCourseId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceCourseId,
					sourceLessonId: AI_CODING_CRASH_COURSE_FINAL_QUIZ.sourceLessonId,
					sourceQuestionId: question.sourceQuestionId,
				},
			}),
		),
	])
	await database.insert(schema.contentResourceResource).values([
		{ resourceOfId: sectionId, resourceId: lessonId, position: 0 },
		...AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredQuestions.map(
			(question, position) => ({
				resourceOfId: lessonId,
				resourceId: question.targetQuestionId,
				position,
			}),
		),
	])
}

async function seedResponses(database: IntegrationDatabase) {
	await database.insert(schema.questionResponse).values(
		AI_CODING_CRASH_COURSE_FINAL_QUIZ.requiredQuestions.map(
			(question, index) => ({
				id: `response-${index}`,
				surveyId: lessonId,
				questionId: question.targetQuestionId,
				respondentKey: `user:${userId}`,
				surveySessionId: null,
				userId,
				emailListSubscriberId: null,
				fields: { answer: 'correct', correct: true },
				createdAt: new Date(now.getTime() + index * 1_000),
				updatedAt: new Date(now.getTime() + index * 1_000),
			}),
		),
	)
}

function resource(
	id: string,
	type: string,
	fields: NonNullable<typeof schema.contentResource.$inferInsert.fields>,
) {
	return {
		id,
		type,
		createdById: 'test',
		fields,
		createdAt: now,
		updatedAt: now,
	}
}
