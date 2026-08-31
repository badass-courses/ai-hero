import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { Effect, Either } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { decideEmailCourse } from './email-course/decision'
import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from './email-course/definition'
import type {
	AutomationControl,
	CommunicationDecision,
	EmailCoursePlanningState,
	EmailCourseStimulus,
} from './email-course/domain'
import { createDrizzleEmailCourseLedger } from './email-course-drizzle-ledger'
import type { DrovrParityReceiptSink } from './email-course/parity-receipt'
import {
	deriveCourseRunId,
	parseContactId,
	parseCourseId,
	parseCoursePathId,
	parseCourseStepId,
	parseEventId,
	parseIsoInstant,
	parseStimulusId,
	type ParseResult,
} from './email-course/primitives'
import type {
	CommunicationSafetyPolicy,
	CourseScheduleDecision,
	EmailCourseAutomationControlRepository,
	EmailCourseCommit,
	EmailCourseDefinitionRegistry,
} from './email-course/ports'
import { createEmailCourseScheduler } from './email-course/scheduler'
import { createAdvanceEmailCourse } from './email-course/service'

const mysqlServerUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const startedAt = instant('2026-09-01T16:00:00.000Z')
const contactId = value(parseContactId('contact-mysql-course'))
const courseId = value(parseCourseId('skills-workflow'))
const entryEventId = value(parseEventId('entry-mysql-course'))
const runId = deriveCourseRunId({ courseId, entryEventId })
const enabled: AutomationControl = {
	type: 'Enabled',
	version: 'control-v1',
	enabledAt: startedAt,
}
const allow: CommunicationDecision = { type: 'Allow' }

integration('Email Course MySQL ledger', () => {
	let serverPool: Pool
	let pool: Pool
	let databaseName: string
	let ledger: ReturnType<typeof createDrizzleEmailCourseLedger>
	let advance: ReturnType<typeof createAdvanceEmailCourse>

	beforeAll(async () => {
		const safeServerUrl = validateMySqlIntegrationServerUrl(mysqlServerUrl!, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		serverPool = mysql.createPool({
			uri: safeServerUrl.toString(),
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		databaseName = `aih_email_course_test_${randomUUID().replaceAll('-', '')}`
		await serverPool.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const databaseUrl = new URL(safeServerUrl)
		databaseUrl.pathname = `/${databaseName}`
		pool = mysql.createPool({
			uri: databaseUrl.toString(),
			connectionLimit: 8,
			timezone: 'Z',
			multipleStatements: true,
		})
		for (const migrationPath of [
			'../../db/migrations/20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'../../db/migrations/20260714_ai_hero_optin_attribution.sql',
			'../../db/migrations/20260717_ai_hero_side_effect_intent_completed_at.sql',
			'../../db/migrations/20260831_ai_hero_email_course_evergreen_schema.sql',
		]) {
			const sql = await fs.readFile(
				new URL(migrationPath, import.meta.url),
				'utf8',
			)
			await pool.query(sql)
		}
		const database = drizzle(pool, {
			schema: databaseSchema,
			mode: 'planetscale',
		})
		ledger = createDrizzleEmailCourseLedger(
			database,
			AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
		)
		advance = createAdvanceEmailCourse({
			ledger,
			definitions: definitionRegistry(),
			controls: controlRepository(),
			communication: communicationPolicy(),
			scheduler: createEmailCourseScheduler(),
			parityReceiptSink: noParity(),
		})
	})

	beforeEach(async () => {
		await pool.query('SET FOREIGN_KEY_CHECKS = 0')
		for (const table of [
			'AI_EmailCourseCommit',
			'AI_AutomationControl',
			'AI_SideEffectIntent',
			'AI_NextAction',
			'AI_ContactEvent',
			'AI_ContactState',
			'AI_ProviderIdentity',
			'AI_Contact',
		]) {
			await pool.query(`TRUNCATE TABLE \`${table}\``)
		}
		await pool.query('SET FOREIGN_KEY_CHECKS = 1')
		await seedEntry(pool)
	})

	afterAll(async () => {
		await pool?.end()
		if (serverPool && databaseName) {
			await serverPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
		}
		await serverPool?.end()
	})

	it('records a missing-control hard stop without an outbox intent', async () => {
		const stoppedAdvance = createAdvanceEmailCourse({
			ledger,
			definitions: definitionRegistry(),
			controls: {
				readEffective: () =>
					Effect.succeed({
						type: 'Stopped' as const,
						source: 'Missing' as const,
						version: null,
						reason: 'MissingControl' as const,
						stoppedAt: null,
					}),
			},
			communication: communicationPolicy(),
			scheduler: createEmailCourseScheduler(),
			parityReceiptSink: noParity(),
		})
		const result = await Effect.runPromise(
			stoppedAdvance({ stimulus: signup() }),
		)
		const [controls] = await pool.query<RowDataPacket[]>(
			'SELECT * FROM AI_AutomationControl',
		)

		expect(result).toMatchObject({
			committed: true,
			decision: {
				type: 'Accepted',
				next: {
					phase: 'stopped',
					reason: { type: 'AutomationStopped', reason: 'MissingControl' },
				},
				outboxChanges: [],
			},
		})
		expect(await activeIntents(pool)).toHaveLength(0)
		expect(controls).toHaveLength(0)
	})

	it('replays a duplicate stimulus without another commit or active intent', async () => {
		const stimulus = signup()
		const first = await Effect.runPromise(advance({ stimulus }))
		const replay = await Effect.runPromise(advance({ stimulus }))
		const [commits] = await pool.query<RowDataPacket[]>(
			'SELECT * FROM AI_EmailCourseCommit WHERE runId = ?',
			[runId],
		)
		const active = await activeIntents(pool)

		expect(first).toMatchObject({ committed: true, replayedStimulus: false })
		expect(replay).toMatchObject({ committed: false, replayedStimulus: true })
		expect(replay.decision).toEqual(first.decision)
		expect(commits).toHaveLength(1)
		expect(active).toHaveLength(1)
		expect(active[0]?.activeSlot).toBe('next')
	})

	it('repaths the unsent next intent without leaving the old route active', async () => {
		await Effect.runPromise(advance({ stimulus: signup() }))
		let state = await requireState(ledger)
		await Effect.runPromise(
			advance({
				stimulus: delivery(state, 'delivery-email-0-repath', startedAt),
			}),
		)
		state = await requireState(ledger)
		await Effect.runPromise(
			advance({
				stimulus: {
					type: 'AnswerSelected',
					stimulusId: value(parseStimulusId('answer-email-0-team-mysql')),
					runId,
					answerEventId: value(parseEventId('answer-email-0-team-mysql')),
					sentStepId: value(parseCourseStepId('individual.email-0')),
					selectedPathId: value(
						parseCoursePathId('ai-hero-skills-team-workflow'),
					),
					selectedNextStepId: value(parseCourseStepId('team.email-1')),
					occurredAt: instant('2026-09-01T16:01:00.000Z'),
				},
			}),
		)
		const active = await activeIntents(pool)
		const [superseded] = await pool.query<RowDataPacket[]>(
			"SELECT * FROM AI_SideEffectIntent WHERE courseRunId = ? AND status = 'superseded'",
			[runId],
		)

		expect(active).toHaveLength(1)
		expect(active[0]).toMatchObject({
			intentPathId: 'ai-hero-skills-team-workflow',
			intentStepId: 'team.email-1',
		})
		expect(superseded).toHaveLength(1)
		expect(superseded[0]?.activeSlot).toBeNull()
	})

	it('rejects one stale optimistic commit', async () => {
		await Effect.runPromise(advance({ stimulus: signup() }))
		const state = await Effect.runPromise(ledger.load(runId))
		if (!state?.currentIntent) throw new Error('Expected active Email 0')
		const applied = delivery(state, 'optimistic-applied', startedAt)
		const ambiguous: EmailCourseStimulus = {
			type: 'DeliverySettled',
			stimulusId: value(parseStimulusId('optimistic-ambiguous')),
			runId,
			intentId: state.currentIntent.id,
			outcome: {
				type: 'Ambiguous',
				reason: 'provider-timeout',
				observedAt: startedAt,
			},
			occurredAt: startedAt,
		}
		const candidates = [
			commitCandidate(state, applied),
			commitCandidate(state, ambiguous),
		]
		const results = await Promise.all(
			candidates.map((candidate) =>
				Effect.runPromise(Effect.either(ledger.commit(candidate))),
			),
		)
		const failures = results.filter(Either.isLeft)

		expect(results.filter(Either.isRight)).toHaveLength(1)
		expect(failures).toHaveLength(1)
		expect(failures[0]?.left).toEqual({
			type: 'CourseRunVersionConflict',
			runId,
		})
		expect(await activeIntents(pool)).toHaveLength(1)
	})

	it('keeps one active next intent when delivery and answer race', async () => {
		await Effect.runPromise(advance({ stimulus: signup() }))
		let state = await requireState(ledger)
		await Effect.runPromise(
			advance({ stimulus: delivery(state, 'delivery-email-0', startedAt) }),
		)
		state = await requireState(ledger)
		const deliveryEmailOne = delivery(
			state,
			'delivery-email-1-race',
			instant('2026-09-02T16:00:00.000Z'),
		)
		const answer: EmailCourseStimulus = {
			type: 'AnswerSelected',
			stimulusId: value(parseStimulusId('answer-email-0-race')),
			runId,
			answerEventId: value(parseEventId('answer-email-0-race')),
			sentStepId: value(parseCourseStepId('individual.email-0')),
			selectedPathId: value(parseCoursePathId('ai-hero-skills-workflow')),
			selectedNextStepId: value(parseCourseStepId('individual.email-1')),
			occurredAt: instant('2026-09-02T15:59:59.000Z'),
		}

		const results = await Promise.all([
			Effect.runPromise(advance({ stimulus: deliveryEmailOne })),
			Effect.runPromise(advance({ stimulus: answer })),
		])
		const active = await activeIntents(pool)

		expect(results).toHaveLength(2)
		expect(active).toHaveLength(1)
		expect(active[0]?.courseRunId).toBe(runId)
		const [duplicates] = await pool.query<RowDataPacket[]>(
			`SELECT courseRunId, activeSlot, COUNT(*) AS count
       FROM AI_SideEffectIntent
       WHERE activeSlot IS NOT NULL
       GROUP BY courseRunId, activeSlot
       HAVING COUNT(*) > 1`,
		)
		expect(duplicates).toHaveLength(0)
	})

	it('atomically plans Email 7 and commits one sequence-exhaustion fact', async () => {
		await Effect.runPromise(advance({ stimulus: signup() }))
		let beforeTerminal: EmailCoursePlanningState | null = null
		for (let position = 0; position <= 6; position += 1) {
			const state = await requireState(ledger)
			if (position === 6) beforeTerminal = state
			await Effect.runPromise(
				advance({
					stimulus: delivery(
						state,
						`delivery-terminal-${position}`,
						instant(
							`2026-09-${String(position + 2).padStart(2, '0')}T16:00:00.000Z`,
						),
					),
				}),
			)
		}
		const state = await requireState(ledger)
		const [facts] = await pool.query<RowDataPacket[]>(
			`SELECT *,
			 JSON_UNQUOTE(JSON_EXTRACT(payloadSummary, '$.coursePayload.format')) AS coursePayloadFormat,
			 JSON_UNQUOTE(JSON_EXTRACT(payloadSummary, '$.coursePayload.payload.progression.trigger.type')) AS triggerType,
			 JSON_UNQUOTE(JSON_EXTRACT(payloadSummary, '$.coursePayload.payload.progression.trigger.policy')) AS triggerPolicy
			 FROM AI_ContactEvent WHERE eventType = 'course.sequence-exhausted'`,
		)
		const active = await activeIntents(pool)

		expect(state.run).toMatchObject({
			phase: 'sequenceExhausted',
			terminalStepId: 'individual.email-7',
		})
		expect(state.currentIntent).toMatchObject({
			status: 'Pending',
			stepId: 'individual.email-7',
		})
		expect(active).toHaveLength(1)
		expect(facts).toHaveLength(1)
		expect(facts[0]).toMatchObject({
			coursePayloadFormat: 'email-course.sequence-exhausted.v1',
			triggerType: 'DeliverySettled',
			triggerPolicy: 'ExplicitTwentyFourHourFallback',
		})

		if (!beforeTerminal) throw new Error('Expected Email 6 state')
		const replay = await Effect.runPromise(
			advance({
				stimulus: delivery(
					beforeTerminal,
					'delivery-terminal-6',
					instant('2026-09-08T16:00:00.000Z'),
				),
			}),
		)
		expect(replay).toMatchObject({ committed: false, replayedStimulus: true })
		expect(await factCount(pool)).toBe(1)
	})
})

function definitionRegistry(): EmailCourseDefinitionRegistry {
	return { get: () => Effect.succeed(AI_HERO_SKILLS_WORKFLOW_COURSE_V1) }
}

function controlRepository(): EmailCourseAutomationControlRepository {
	return { readEffective: () => Effect.succeed(enabled) }
}

function communicationPolicy(): CommunicationSafetyPolicy {
	return { decide: () => Effect.succeed(allow) }
}

function noParity(): DrovrParityReceiptSink {
	return { push: () => Effect.void }
}

function signup(): EmailCourseStimulus {
	return {
		type: 'ExplicitSignup',
		stimulusId: value(parseStimulusId('signup-mysql-course')),
		contactId,
		courseId,
		entryEventId,
		scheduleEvidence: {
			type: 'ExplicitFallback',
			reason: 'header-missing',
			timeZone: 'America/Los_Angeles',
			capturedAt: startedAt,
		},
		occurredAt: startedAt,
	}
}

function delivery(
	state: EmailCoursePlanningState,
	stimulusId: string,
	appliedAt: ReturnType<typeof instant>,
): EmailCourseStimulus {
	if (!state.currentIntent) throw new Error('Expected current intent')
	return {
		type: 'DeliverySettled',
		stimulusId: value(parseStimulusId(stimulusId)),
		runId,
		intentId: state.currentIntent.id,
		outcome: {
			type: 'Applied',
			deliveryReceiptId: `provider:${stimulusId}`,
			appliedAt,
		},
		occurredAt: appliedAt,
	}
}

function commitCandidate(
	state: EmailCoursePlanningState,
	stimulus: EmailCourseStimulus,
): EmailCourseCommit {
	const schedule: CourseScheduleDecision = {
		availableAt: instant('2026-09-02T16:00:00.000Z'),
		policy: 'ExplicitTwentyFourHourFallback',
	}
	const result = decideEmailCourse({
		definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
		state,
		stimulus,
		automationControl: enabled,
		communication: allow,
		schedule: stimulus.type === 'DeliverySettled' ? schedule : null,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected accepted candidate')
	}
	return {
		stimulus,
		expectedVersion: state.run.actorVersion,
		previous: state,
		definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
		automationControl: enabled,
		communication: allow,
		decidedAt: stimulus.occurredAt,
		decision: result.decision,
	}
}

async function requireState(
	ledger: ReturnType<typeof createDrizzleEmailCourseLedger>,
): Promise<EmailCoursePlanningState> {
	const state = await Effect.runPromise(ledger.load(runId))
	if (!state) throw new Error('Expected Email Course state')
	return state
}

async function activeIntents(pool: Pool) {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT *,
		 JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.intent.pathId')) AS intentPathId,
		 JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.intent.stepId')) AS intentStepId
		 FROM AI_SideEffectIntent
		 WHERE courseRunId = ? AND activeSlot = 'next'`,
		[runId],
	)
	return rows
}

async function factCount(pool: Pool) {
	const [rows] = await pool.query<RowDataPacket[]>(
		"SELECT COUNT(*) AS count FROM AI_ContactEvent WHERE eventType = 'course.sequence-exhausted'",
	)
	return Number(rows[0]?.count ?? 0)
}

async function seedEntry(pool: Pool) {
	await pool.query(
		`INSERT INTO AI_Contact
     (id, email, lifecycle, isProvisional, createdAt, updatedAt)
     VALUES (?, 'learner@example.com', 'nurture-ready', false, ?, ?)`,
		[contactId, new Date(startedAt), new Date(startedAt)],
	)
	await pool.query(
		`INSERT INTO AI_ProviderIdentity
     (id, contactId, provider, externalId, evidence, createdAt, updatedAt)
     VALUES ('identity-mysql-course', ?, 'ai-hero', ?, ?, ?, ?)`,
		[
			contactId,
			contactId,
			JSON.stringify({ source: 'ai-hero', strength: 'strong' }),
			new Date(startedAt),
			new Date(startedAt),
		],
	)
	await pool.query(
		`INSERT INTO AI_ContactEvent
     (id, contactId, providerIdentityId, provider, providerEventId,
      providerReference, eventType, semanticIdempotencyKey, privacyLevel,
      identityEvidence, payloadSummary, schemaVersion, occurredAt, createdAt)
     VALUES (?, ?, 'identity-mysql-course', 'ai-hero', ?, ?,
      'value-path.entered', ?, 'internal', ?, ?, 1, ?, ?)`,
		[
			entryEventId,
			contactId,
			entryEventId,
			`value-path:${courseId}`,
			entryEventId,
			JSON.stringify({ source: 'ai-hero', strength: 'strong' }),
			JSON.stringify({
				summary: 'Entered Email Course',
				keywords: ['value-path', 'entered'],
				restrictedPayloadStored: false,
			}),
			new Date(startedAt),
			new Date(startedAt),
		],
	)
}

function instant(input: string) {
	return value(parseIsoInstant(input))
}

function value<Value>(result: ParseResult<Value>): Value {
	if (result.ok) return result.value
	throw new Error(result.error.reason)
}
