import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import {
	contact,
	contactEvent,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
} from '@/db/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import {
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	deadlineTimeZoneEvidenceFromHeader,
} from './course-sequence-exhaustion'
import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import type { SideEffectIntent } from './types'
import { progressValuePathDrips } from './value-path-drip-progression'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

const mysqlServerUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const now = '2026-08-03T00:00:00.000Z'
const completedAt = '2026-08-01T00:00:00.000Z'
const schema = {
	contact,
	contactEvent,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
}

function allowlist(): GateDRuntimeAllowlist {
	return {
		activationId: 'sequence-exhaustion-mysql-test',
		status: 'active',
		killSwitch: false,
		mode: 'scoped-live',
		authorizationMode: 'rolling-public-enrollment',
		pathSlugs: ['ai-hero-skills-workflow'],
		contactIds: ['contact-1'],
		kitSubscriberIds: ['kit-1'],
		emails: ['learner@example.com'],
		emailHashes: [],
		emailResourceIds: ['ai-hero-skills-workflow.email-7'],
		kitSequenceIds: ['2831545'],
		candidates: [],
		allowedActions: ['advance-by-daily-drip', 'send-path-emails'],
		createdAt: completedAt,
	}
}

function sourceIntent(): SideEffectIntent {
	return {
		id: 'email-6-intent',
		nextActionId: 'email-6-action',
		contactId: 'contact-1',
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'completed',
		completedAt,
		idempotencyKey: 'email-6-key',
		gates: [],
		reviewReasons: [],
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-6',
			kitSequenceId: '2757205',
			kitSubscriberId: 'kit-1',
			courseEntryEventId: 'course-entry',
			courseDeadlineTimeZone: browserDeadline(),
		},
		createdAt: completedAt,
	}
}

function browserDeadline() {
	const result = deadlineTimeZoneEvidenceFromHeader({
		headerValue: 'Asia/Tokyo',
		capturedAt: completedAt,
	})
	if (!result.ok) throw new Error(result.error.detail)
	return result.value
}

integration('course sequence exhaustion MySQL contract', () => {
	let serverPool: Pool
	let pool: Pool
	let repository: DrizzleCaptureMarketingRepository
	let databaseName: string

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
		databaseName = `aih_course_sequence_test_${randomUUID().replaceAll('-', '')}`
		await serverPool.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const databaseUrl = new URL(safeServerUrl)
		databaseUrl.pathname = `/${databaseName}`
		pool = mysql.createPool({
			uri: databaseUrl.toString(),
			connectionLimit: 4,
			timezone: 'Z',
			multipleStatements: true,
		})
		for (const migrationPath of [
			'../../db/migrations/20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'../../db/migrations/20260714_ai_hero_optin_attribution.sql',
			'../../db/migrations/20260717_ai_hero_side_effect_intent_completed_at.sql',
			'../../db/migrations/20260830_ai_hero_course_sequence_exhaustion.sql',
		]) {
			const sql = await fs.readFile(new URL(migrationPath, import.meta.url), 'utf8')
			await pool.query(sql)
		}
		const database = drizzle(pool, { schema, mode: 'planetscale' })
		repository = new DrizzleCaptureMarketingRepository(database)
	})

	beforeEach(async () => {
		await pool.query('SET FOREIGN_KEY_CHECKS = 0')
		for (const table of [
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
		await seedCourseFrontier(pool)
	})

	afterAll(async () => {
		await pool?.end()
		if (serverPool && databaseName) {
			await serverPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
		}
		await serverPool?.end()
	})

	it('commits and replays one fact, action, and terminal intent', async () => {
		const first = await progressValuePathDrips({
			repository,
			allowlist: allowlist(),
			completedIntents: [sourceIntent()],
			allowWrite: true,
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
		})
		const second = await progressValuePathDrips({
			repository,
			allowlist: allowlist(),
			completedIntents: [sourceIntent()],
			allowWrite: true,
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
		})
		const [facts] = await pool.query<RowDataPacket[]>(
			"SELECT * FROM AI_ContactEvent WHERE eventType = 'course.sequence-exhausted'",
		)
		const [intents] = await pool.query<RowDataPacket[]>(
			"SELECT * FROM AI_SideEffectIntent WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.emailResourceId')) = 'ai-hero-skills-workflow.email-7'",
		)
		const [actions] = await pool.query<RowDataPacket[]>(
			'SELECT * FROM AI_NextAction WHERE eventId = ?',
			[facts[0]?.id],
		)

		expect(first.counts.planned).toBe(1)
		expect(second.counts.idempotentNoop).toBe(1)
		expect(second.results[0]).toMatchObject({
			contactEventId: facts[0]?.id,
			nextActionId: actions[0]?.id,
			sideEffectIntentId: intents[0]?.id,
		})
		expect(facts).toHaveLength(1)
		expect(intents).toHaveLength(1)
		expect(actions).toHaveLength(1)
		expect(intents[0]?.nextActionId).toBe(actions[0]?.id)
		const domainPayload =
			typeof facts[0]?.domainPayload === 'string'
				? JSON.parse(facts[0].domainPayload)
				: facts[0]?.domainPayload
		expect(domainPayload).toMatchObject({
			deadlineTimeZone: {
				type: 'BrowserEntryHeader',
				timeZone: 'Asia/Tokyo',
			},
		})

		await pool.query(
			"UPDATE AI_SideEffectIntent SET status = 'completed', completedAt = ? WHERE id = ?",
			[new Date('2026-08-03T01:00:00.000Z'), intents[0]?.id],
		)
		const afterSettlement = await progressValuePathDrips({
			repository,
			allowlist: allowlist(),
			completedIntents: [sourceIntent()],
			allowWrite: true,
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
		})
		expect(afterSettlement.counts.idempotentNoop).toBe(1)
		expect(afterSettlement.results[0]).toMatchObject({
			contactEventId: facts[0]?.id,
			nextActionId: actions[0]?.id,
			sideEffectIntentId: intents[0]?.id,
		})
	})

	it('does not mint a fact for a historical terminal intent', async () => {
		await pool.query(
			`INSERT INTO AI_SideEffectIntent
			(id, nextActionId, contactId, provider, type, status, completedAt,
			 idempotencyKey, gates, reviewReasons, metadata, createdAt)
			VALUES (?, ?, ?, 'kit', 'send-value-path-email', 'completed', ?, ?, '[]', '[]', ?, ?)`,
			[
				'historical-email-7',
				'historical-action',
				'contact-1',
				new Date('2026-08-02T00:00:00.000Z'),
				'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-7',
				JSON.stringify({
					valuePathSlug: 'ai-hero-skills-workflow',
					emailResourceId: 'ai-hero-skills-workflow.email-7',
				}),
				new Date('2026-08-02T00:00:00.000Z'),
			],
		)

		const result = await progressValuePathDrips({
			repository,
			allowlist: allowlist(),
			completedIntents: [sourceIntent()],
			allowWrite: true,
			email7LiveEnabled: true,
			sequenceExhaustionEnabled: true,
			now,
		})
		const [facts] = await pool.query<RowDataPacket[]>(
			"SELECT id FROM AI_ContactEvent WHERE eventType = 'course.sequence-exhausted'",
		)

		expect(result.counts.idempotentNoop).toBe(1)
		expect(facts).toHaveLength(0)
	})
})

async function seedCourseFrontier(pool: Pool) {
	const deadline = browserDeadline()
	await pool.query(
		`INSERT INTO AI_Contact
		(id, email, lifecycle, isProvisional, createdAt, updatedAt)
		VALUES ('contact-1', 'learner@example.com', 'nurture-ready', false, ?, ?)`,
		[new Date(completedAt), new Date(completedAt)],
	)
	await pool.query(
		`INSERT INTO AI_ProviderIdentity
		(id, contactId, provider, externalId, evidence, createdAt, updatedAt)
		VALUES ('identity-1', 'contact-1', 'ai-hero', 'contact-1', ?, ?, ?)`,
		[
			JSON.stringify({ source: 'ai-hero', strength: 'strong' }),
			new Date(completedAt),
			new Date(completedAt),
		],
	)
	await pool.query(
		`INSERT INTO AI_ContactState
		(id, contactId, lifecycle, primaryBucket, allBuckets, whySignals,
		 whoSignals, confidence, rationale, reviewSignals, humanReview,
		 lastEventId, schemaVersion, updatedAt)
		VALUES ('state-1', 'contact-1', 'nurture-ready', 'other-unclear',
		 '[]', '[]', '[]', 1, '[]', '[]', false, 'course-entry', 1, ?)`,
		[new Date(completedAt)],
	)
	await pool.query(
		`INSERT INTO AI_ContactEvent
		(id, contactId, providerIdentityId, provider, providerEventId,
		 providerReference, eventType, semanticIdempotencyKey, payloadFormat,
		 domainPayload, privacyLevel, identityEvidence, payloadSummary,
		 schemaVersion, occurredAt, createdAt)
		VALUES ('course-entry', 'contact-1', 'identity-1', 'ai-hero',
		 'course-entry', 'value-path:ai-hero-skills-workflow',
		 'value-path.entered', 'course-entry', ?, ?, 'internal', ?, ?, 1, ?, ?)`,
		[
			EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
			JSON.stringify({
				format: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
				valuePathId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				deadlineTimeZone: deadline,
			}),
			JSON.stringify({ source: 'ai-hero', strength: 'strong' }),
			JSON.stringify({
				summary: 'Entered course',
				keywords: ['value-path', 'entered'],
				restrictedPayloadStored: false,
			}),
			new Date(completedAt),
			new Date(completedAt),
		],
	)
	await pool.query(
		`INSERT INTO AI_SideEffectIntent
		(id, nextActionId, contactId, provider, type, status, completedAt,
		 idempotencyKey, gates, reviewReasons, metadata, createdAt)
		VALUES ('email-6-intent', 'email-6-action', 'contact-1', 'kit',
		 'send-value-path-email', 'completed', ?, 'email-6-key', '[]', '[]', ?, ?)`,
		[
			new Date(completedAt),
			JSON.stringify(sourceIntent().metadata),
			new Date(completedAt),
		],
	)
}
