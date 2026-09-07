import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as mysqlQueryClient from '@/db/mysql-query-client'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { Effect, Either } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

import {
	deadlineTimeZoneEvidenceFromHeader,
	decideEvergreenOfferJourney,
	EVERGREEN_OFFER_JOURNEY_V1,
} from '.'
import type {
	DeliveryOutcome,
	EligibilityFacts,
	EvergreenOfferStimulus,
	JourneyDecision,
} from './domain'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import type { JourneyLedgerCommit } from './ports'
import {
	parseContactId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type ParseResult,
} from './primitives'

const mysqlServerUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const contactId = value(parseContactId('contact_mysql_ledger'))
const entryFactId = value(parseEntryFactId('entry_mysql_ledger'))
const exhaustedAt = instant('2026-09-04T17:00:00.000Z')
const timeZone = value(parseIanaTimeZone('America/Los_Angeles'))
const tableNames = [
	'AI_EvergreenOfferJourneyAttempt',
	'AI_EvergreenOfferJourneyWake',
	'AI_EvergreenOfferJourneyIntent',
	'AI_EvergreenOfferJourneyCommit',
] as const
const deliveryScenarios = [
	{
		name: 'applied delivery',
		outcome: { type: 'Applied', providerReceiptId: 'provider-applied' },
		expectedStatus: 'Applied',
	},
	{
		name: 'message refusal',
		outcome: { type: 'MessageRefused', reason: 'provider-refused' },
		expectedStatus: 'Refused',
	},
	{
		name: 'ambiguous delivery',
		outcome: { type: 'Ambiguous', reason: 'provider-timeout' },
		expectedStatus: 'Ambiguous',
	},
	{
		name: 'contact failure',
		outcome: { type: 'ContactUndeliverable', reason: 'hard-bounce' },
		expectedStatus: 'Refused',
	},
] as const satisfies readonly {
	readonly name: string
	readonly outcome: DeliveryOutcome
	readonly expectedStatus: string
}[]

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
	return {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' },
		existingJourneyId: null,
		automationControl: { type: 'Enabled', version: 'control-v1' },
		evidenceVersion: 'facts-v1',
		readAt: exhaustedAt,
		...overrides,
	}
}

function entry(
	stimulusName = 'stimulus_mysql_entry',
	identity = { contactId, entryFactId },
	valuePathId = 'ai-hero-skills-workflow-individual-v1',
) {
	const deadlineTimeZone = deadlineTimeZoneEvidenceFromHeader({
		headerValue: timeZone,
		capturedAt: exhaustedAt,
	})
	if (!deadlineTimeZone.ok) throw new Error(deadlineTimeZone.error.detail)
	const stimulus: EvergreenOfferStimulus = {
		type: 'CourseSequenceExhausted',
		stimulusId: value(parseStimulusId(stimulusName)),
		entryFactId: identity.entryFactId,
		contactId: identity.contactId,
		valuePathId,
		exhaustedAt,
		deadlineTimeZone: deadlineTimeZone.value,
		sourceReference: `contact-event:${stimulusName}`,
	}
	const result = decideEvergreenOfferJourney({
		snapshot: null,
		stimulus,
		currentFacts: facts({ contactId: identity.contactId }),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: exhaustedAt,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected accepted entry')
	}
	return {
		stimulus,
		decision: result.decision,
		commit: {
			...commitRecord(stimulus, result.decision, null),
			currentFacts: facts({ contactId: identity.contactId }),
		},
	}
}

function wakeCommit(
	current: ReturnType<typeof entry>['decision']['next'],
	wakeIndex: number,
	stimulusName: string,
) {
	const wake = current.messagePlan.bridge[wakeIndex]
	if (!wake) throw new Error(`Missing bridge slot ${wakeIndex}`)
	const scheduled = entry().decision.wakeIntents.find(
		(candidate) =>
			candidate.purpose.type === 'MessageSlot' &&
			candidate.purpose.slotId === wake.slotId,
	)
	if (!scheduled) throw new Error(`Missing wake ${wake.slotId}`)
	const stimulus: EvergreenOfferStimulus = {
		type: 'WakeDue',
		stimulusId: value(parseStimulusId(stimulusName)),
		journeyId: current.journeyId,
		wakeId: scheduled.wakeId,
		dueAt: scheduled.dueAt,
		purpose: scheduled.purpose,
	}
	const result = decideEvergreenOfferJourney({
		snapshot: current,
		stimulus,
		currentFacts: facts({ existingJourneyId: current.journeyId }),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: scheduled.dueAt,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected accepted wake')
	}
	return commitRecord(stimulus, result.decision, current.version)
}

function deliveryCommit(
	current: ReturnType<typeof entry>['decision']['next'],
	intent: Extract<
		ReturnType<typeof wakeCommit>['decision']['sideEffectIntents'][number],
		{ type: 'SendMessage' }
	>,
	stimulusName: string,
	outcome: DeliveryOutcome = {
		type: 'Applied',
		providerReceiptId: `provider:${stimulusName}`,
	},
) {
	const stimulus: EvergreenOfferStimulus = {
		type: 'DeliverySettled',
		stimulusId: value(parseStimulusId(stimulusName)),
		journeyId: current.journeyId,
		slotId: intent.slotId,
		intentKey: intent.idempotencyKey,
		settledAt: intent.notBefore,
		outcome,
	}
	const result = decideEvergreenOfferJourney({
		snapshot: current,
		stimulus,
		currentFacts: facts({ existingJourneyId: current.journeyId }),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: stimulus.settledAt,
	})
	if (!result.ok || result.decision.type !== 'Accepted') {
		throw new Error('Expected accepted delivery receipt')
	}
	return commitRecord(stimulus, result.decision, current.version)
}

function commitRecord(
	stimulus: EvergreenOfferStimulus,
	decision: Extract<JourneyDecision, { type: 'Accepted' }>,
	expectedVersion: number | null,
): JourneyLedgerCommit {
	return {
		stimulus,
		expectedVersion,
		currentFacts: facts({
			existingJourneyId:
				expectedVersion === null ? null : decision.next.journeyId,
		}),
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		decidedAt: decision.transitionReceipt.committedAt,
		decision,
	}
}

function createConnection(uri: string) {
	const pool = mysqlQueryClient.preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 1, timezone: 'Z' }),
	)
	const database = drizzle(pool, {
		schema: journeySchema,
		mode: 'planetscale',
	})
	return {
		pool,
		ledger: createDrizzleJourneyLedger(database),
		attempts: createDrizzleJourneyAttempts(database),
	}
}

integration('evergreen offer journey MySQL ledger', () => {
	let serverPool: Pool
	let adminPool: Pool
	let first: ReturnType<typeof createConnection>
	let second: ReturnType<typeof createConnection>
	let databaseName: string
	let migration: string

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
		databaseName = `aih_evergreen_journey_test_${randomUUID().replaceAll('-', '')}`
		await serverPool.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const databaseUrl = new URL(safeServerUrl)
		databaseUrl.pathname = `/${databaseName}`
		adminPool = mysql.createPool({
			uri: databaseUrl.toString(),
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		migration = await fs.readFile(
			new URL(
				'../../../db/migrations/20260831_ai_hero_email_course_evergreen_schema.sql',
				import.meta.url,
			),
			'utf8',
		)
		await adminPool.query(migration)
		await adminPool.query(
			await fs.readFile(
				new URL(
					'../../../db/migrations/20260907_evergreen_admission_attempts.sql',
					import.meta.url,
				),
				'utf8',
			),
		)
		first = createConnection(databaseUrl.toString())
		second = createConnection(databaseUrl.toString())
	})

	beforeEach(async () => {
		for (const table of tableNames) {
			await adminPool.query(`DELETE FROM \`${table}\``)
		}
	})

	afterAll(async () => {
		await first.pool.end()
		await second.pool.end()
		await adminPool.end()
		await serverPool.query(`DROP DATABASE \`${databaseName}\``)
		await serverPool.end()
	})

	it('persists, restores, inspects, and replays one exact committed decision', async () => {
		const start = entry()
		const committed = await Effect.runPromise(first.ledger.commit(start.commit))
		const loaded = await Effect.runPromise(
			second.ledger.load(start.decision.next.journeyId),
		)
		const replay = await Effect.runPromise(second.ledger.commit(start.commit))
		const inspection = await Effect.runPromise(
			second.ledger.inspect({
				journeyId: start.decision.next.journeyId,
				now: exhaustedAt,
				automationControl: 'Enabled',
			}),
		)

		expect(committed).toMatchObject({
			committed: true,
			replayedStimulus: false,
		})
		expect(loaded).toEqual(start.decision.next)
		expect(replay).toEqual({
			decision: start.decision,
			committed: false,
			replayedStimulus: true,
		})
		expect(inspection.wakes).toHaveLength(start.decision.wakeIntents.length)
		expect(inspection.transitionReceipts).toEqual([
			start.decision.transitionReceipt,
		])
	})

	it('rejects same-ID replay with altered source evidence on lookup and commit', async () => {
		const start = entry()
		await Effect.runPromise(first.ledger.commit(start.commit))
		const altered = {
			...start.stimulus,
			sourceReference: 'contact-event:other',
		}
		const lookup = await Effect.runPromise(
			Effect.either(
				second.ledger.findCommittedStimulus(start.stimulus.stimulusId, altered),
			),
		)
		expect(Either.isLeft(lookup) && lookup.left.type).toBe(
			'JourneyDecodeFailure',
		)
		const replay = await Effect.runPromise(
			Effect.either(
				second.ledger.commit({ ...start.commit, stimulus: altered }),
			),
		)
		expect(Either.isLeft(replay) && replay.left.type).toBe(
			'JourneyDecodeFailure',
		)
	})

	it('commits a duplicate stimulus once across separate connections', async () => {
		const start = entry('stimulus_mysql_duplicate')
		const results = await Promise.all([
			Effect.runPromise(first.ledger.commit(start.commit)),
			Effect.runPromise(second.ledger.commit(start.commit)),
		])
		expect(results.filter((result) => result.committed)).toHaveLength(1)
		expect(results.filter((result) => result.replayedStimulus)).toHaveLength(1)
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(1)
	})

	it('atomically admits only one initial journey per contact across distinct entry facts', async () => {
		const a = entry('entry-path-a')
		const b = entry(
			'entry-path-b',
			{ contactId, entryFactId: value(parseEntryFactId('other-path-fact')) },
			'ai-hero-skills-workflow-team-v1',
		)
		const outcomes = await Promise.all(
			[first.ledger.commit(a.commit), second.ledger.commit(b.commit)].map(
				(effect) => Effect.runPromise(Effect.either(effect)),
			),
		)
		expect(outcomes.filter(Either.isRight)).toHaveLength(1)
		expect(
			outcomes.filter(Either.isLeft).map((result) => result.left.type),
		).toEqual(['JourneyConstraintViolation'])
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(1)
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyWake')).toBe(
			a.decision.wakeIntents.length,
		)
	})

	it('admits different contacts independently', async () => {
		const a = entry('independent-a')
		const b = entry('independent-b', {
			contactId: value(parseContactId('other-contact')),
			entryFactId: value(parseEntryFactId('other-entry')),
		})
		const results = await Promise.all([
			Effect.runPromise(first.ledger.commit(a.commit)),
			Effect.runPromise(second.ledger.commit(b.commit)),
		])
		expect(results.every((result) => result.committed)).toBe(true)
	})

	it('fails closed for unreserved legacy initial rows while preserving reads/replay', async () => {
		const start = entry()
		await Effect.runPromise(first.ledger.commit(start.commit))
		await adminPool.query(
			'UPDATE AI_EvergreenOfferJourneyCommit SET admissionContactId = NULL',
		)
		expect(
			await Effect.runPromise(first.ledger.load(start.decision.next.journeyId)),
		).toEqual(start.decision.next)
		expect(
			(await Effect.runPromise(second.ledger.commit(start.commit)))
				.replayedStimulus,
		).toBe(true)
		const next = entry('legacy-blocked', {
			contactId,
			entryFactId: value(parseEntryFactId('legacy-other')),
		})
		const result = await Effect.runPromise(
			Effect.either(first.ledger.commit(next.commit)),
		)
		expect(Either.isLeft(result) && result.left.type).toBe(
			'JourneyConstraintViolation',
		)
	})

	it('installs unique admission/token keys and bounded recovery indexes', async () => {
		const [rows] = await adminPool.query<
			Array<
				RowDataPacket & {
					INDEX_NAME: string
					NON_UNIQUE: number
					columnNames: string
				}
			>
		>(
			`SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnNames FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('AI_EvergreenOfferJourneyCommit', 'AI_EvergreenOfferJourneyAttempt') GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
		)
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					INDEX_NAME: 'EvergreenOfferJourneyCommit_admission_contact_uq',
					NON_UNIQUE: 0,
					columnNames: 'admissionContactId',
				}),
				expect.objectContaining({
					INDEX_NAME: 'EvergreenOfferJourneyCommit_legacy_admission_idx',
					columnNames: 'admissionContactId,actorVersion',
				}),
				expect.objectContaining({
					INDEX_NAME: 'EvergreenOfferJourneyAttempt_token_uq',
					NON_UNIQUE: 0,
					columnNames: 'claimToken',
				}),
				expect.objectContaining({
					INDEX_NAME: 'EvergreenOfferJourneyAttempt_recovery_idx',
					columnNames: 'status,leaseExpiresAt,idempotencyKey',
				}),
			]),
		)
	})

	it('claims once across connections and never reclaims after crash, lease or window expiry', async () => {
		const start = entry()
		await Effect.runPromise(first.ledger.commit(start.commit))
		const wake = wakeCommit(start.decision.next, 0, 'attempt-wake')
		await Effect.runPromise(first.ledger.commit(wake))
		const intent = wake.decision.sideEffectIntents[0]
		if (!intent || intent.type !== 'SendMessage')
			throw new Error('Expected message')
		const now = new Date(intent.notBefore)
		const leaseExpiresAt = new Date(now.getTime() + 60_000)
		const request = {
			idempotencyKey: intent.idempotencyKey,
			journeyId: intent.journeyId,
			now,
			leaseExpiresAt,
		}
		const results = await Promise.all([
			Effect.runPromise(first.attempts.claim(request)),
			Effect.runPromise(second.attempts.claim(request)),
		])
		expect(results.filter((result) => result.type === 'Claimed')).toHaveLength(
			1,
		)
		expect(
			results.filter((result) => result.type === 'AlreadyAttempted'),
		).toHaveLength(1)
		const winner = results.find((result) => result.type === 'Claimed')
		if (!winner || winner.type !== 'Claimed') throw new Error('No winner')
		for (const expired of [
			leaseExpiresAt,
			new Date(intent.notAfter),
			new Date('2027-01-01'),
		]) {
			expect(
				await Effect.runPromise(
					second.attempts.claim({
						...request,
						now: expired,
						leaseExpiresAt: new Date(expired.getTime() + 60_000),
					}),
				),
			).toEqual({ type: 'AlreadyAttempted', state: 'HeldUncertain' })
		}
		const identity = {
			idempotencyKey: intent.idempotencyKey,
			journeyId: intent.journeyId,
			claimToken: winner.evidence.claimToken,
		}
		const outcome = {
			type: 'Accepted' as const,
			providerReceiptId: 'provider-ack',
			appliedAt: new Date(now.getTime() + 1000).toISOString(),
		}
		for (const mismatch of [
			{ claimToken: randomUUID() },
			{ journeyId: 'wrong-journey' },
			{ idempotencyKey: 'wrong-intent' },
		]) {
			const refused = await Effect.runPromise(
				Effect.either(
					first.attempts.settle({
						...identity,
						...mismatch,
						outcome,
						now: new Date(now.getTime() + 2000),
					}),
				),
			)
			expect(Either.isLeft(refused) && refused.left.type).toBe('AttemptRefused')
		}
		const expiredSettlement = await Effect.runPromise(
			Effect.either(
				first.attempts.settle({ ...identity, outcome, now: leaseExpiresAt }),
			),
		)
		expect(
			Either.isLeft(expiredSettlement) && expiredSettlement.left.type,
		).toBe('AttemptRefused')
		const recovery = await Effect.runPromise(
			second.attempts.recovery({ now: leaseExpiresAt, limit: 1 }),
		)
		expect(recovery).toHaveLength(1)
		expect(recovery[0]?.state).toBe('HeldUncertain')
		const reconciled = await Effect.runPromise(
			second.attempts.reconcileAccepted({
				...identity,
				outcome,
				now: leaseExpiresAt,
			}),
		)
		expect(reconciled.status).toBe('Accepted')
		expect(
			await Effect.runPromise(
				first.attempts.reconcileAccepted({
					...identity,
					outcome,
					now: leaseExpiresAt,
				}),
			),
		).toEqual(reconciled)
		expect(await intentStatus(adminPool, intent.idempotencyKey)).toBe('Pending')
		expect(
			await Effect.runPromise(
				first.attempts.recovery({ now: leaseExpiresAt, limit: 1 }),
			),
		).toEqual([])
	})

	it.each(['Accepted', 'HeldUncertain', 'KnownNotApplied'] as const)(
		'never reclaims an explicit %s outcome',
		async (status) => {
			const start = entry()
			await Effect.runPromise(first.ledger.commit(start.commit))
			const wake = wakeCommit(start.decision.next, 0, 'held-wake')
			await Effect.runPromise(first.ledger.commit(wake))
			const intent = wake.decision.sideEffectIntents[0]
			if (!intent || intent.type !== 'SendMessage')
				throw new Error('Expected message')
			const now = new Date(intent.notBefore)
			const request = {
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now,
				leaseExpiresAt: new Date(now.getTime() + 60_000),
			}
			const claim = await Effect.runPromise(first.attempts.claim(request))
			if (claim.type !== 'Claimed') throw new Error('Expected claim')
			const outcome =
				status === 'Accepted'
					? {
							type: status,
							providerReceiptId: 'accepted-receipt',
							appliedAt: now.toISOString(),
						}
					: status === 'HeldUncertain'
						? { type: status, reason: 'Cancelled' as const }
						: { type: status, reason: 'ProviderRefused' as const }
			const settlement = {
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				claimToken: claim.evidence.claimToken,
				now,
				outcome,
			}
			const settled = await Effect.runPromise(first.attempts.settle(settlement))
			if (status === 'Accepted') {
				expect(
					await Effect.runPromise(second.attempts.settle(settlement)),
				).toEqual(settled)
				const mismatch = await Effect.runPromise(
					Effect.either(
						second.attempts.settle({
							...settlement,
							outcome: {
								type: 'Accepted',
								providerReceiptId: 'conflicting',
								appliedAt: now.toISOString(),
							},
						}),
					),
				)
				expect(Either.isLeft(mismatch) && mismatch.left.type).toBe(
					'AttemptRefused',
				)
			}
			expect(await Effect.runPromise(second.attempts.claim(request))).toEqual({
				type: 'AlreadyAttempted',
				state: status,
			})
			expect(
				await countRows(adminPool, 'AI_EvergreenOfferJourneyAttempt'),
			).toBe(1)
		},
	)

	it('refuses expired fresh intent claims and unbounded recovery', async () => {
		const start = entry()
		await Effect.runPromise(first.ledger.commit(start.commit))
		const wake = wakeCommit(start.decision.next, 0, 'expired-wake')
		await Effect.runPromise(first.ledger.commit(wake))
		const intent = wake.decision.sideEffectIntents[0]
		if (!intent || intent.type !== 'SendMessage')
			throw new Error('Expected message')
		const now = new Date(intent.notAfter)
		const result = await Effect.runPromise(
			Effect.either(
				first.attempts.claim({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					now,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
				}),
			),
		)
		expect(Either.isLeft(result) && result.left.type).toBe('AttemptRefused')
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyAttempt')).toBe(
			0,
		)
		const recovery = await Effect.runPromise(
			Effect.either(first.attempts.recovery({ now, limit: 101 })),
		)
		expect(Either.isLeft(recovery)).toBe(true)
	})

	it.each(deliveryScenarios)(
		'persists $name settlement evidence',
		async (scenario) => {
			const start = entry(`stimulus_mysql_${scenario.outcome.type}_entry`)
			await Effect.runPromise(first.ledger.commit(start.commit))
			const wake = wakeCommit(
				start.decision.next,
				0,
				`stimulus_mysql_${scenario.outcome.type}_wake`,
			)
			await Effect.runPromise(first.ledger.commit(wake))
			const intent = wake.decision.sideEffectIntents[0]
			if (!intent || intent.type !== 'SendMessage') {
				throw new Error('Expected message intent')
			}
			await Effect.runPromise(
				first.ledger.commit(
					deliveryCommit(
						wake.decision.next,
						intent,
						`stimulus_mysql_${scenario.outcome.type}_settled`,
						scenario.outcome,
					),
				),
			)
			expect(await intentStatus(adminPool, intent.idempotencyKey)).toBe(
				scenario.expectedStatus,
			)
		},
	)

	it('persists explicit commit, intent, and wake row formats', async () => {
		const [rows] = await adminPool.query<
			Array<RowDataPacket & { TABLE_NAME: string; COLUMN_NAME: string }>
		>(
			`SELECT TABLE_NAME, COLUMN_NAME
			 FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE()
			   AND TABLE_NAME IN (?, ?, ?, ?)
			   AND COLUMN_NAME = 'format'`,
			[...tableNames],
		)
		expect(rows.map((row) => row.TABLE_NAME).sort()).toEqual(
			[...tableNames].sort(),
		)
		const start = entry('stimulus_mysql_format_entry')
		await Effect.runPromise(first.ledger.commit(start.commit))
		await Effect.runPromise(
			first.ledger.commit(
				wakeCommit(start.decision.next, 0, 'stimulus_mysql_format_wake'),
			),
		)
		await expectRowFormat(
			adminPool,
			'AI_EvergreenOfferJourneyCommit',
			'evergreen-offer-journey.commit.v1',
		)
		await expectRowFormat(
			adminPool,
			'AI_EvergreenOfferJourneyIntent',
			'evergreen-offer-journey.intent.v1',
		)
		await expectRowFormat(
			adminPool,
			'AI_EvergreenOfferJourneyWake',
			'evergreen-offer-journey.wake.v1',
		)
	})

	it.each([
		{
			label: 'intent format',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`format` = 'evergreen-offer-journey.intent.v2'",
			target: 'wake',
		},
		{
			label: 'intent idempotency key',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`idempotencyKey` = CONCAT(`idempotencyKey`, ':corrupt')",
			target: 'wake',
		},
		{
			label: 'intent ordinal',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: '`ordinal` = 5',
			target: 'wake',
		},
		{
			label: 'intent creation time',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: '`createdAt` = DATE_ADD(`createdAt`, INTERVAL 1 SECOND)',
			target: 'wake',
		},
		{
			label: 'intent update time',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: '`updatedAt` = DATE_ADD(`updatedAt`, INTERVAL 1 SECOND)',
			target: 'wake',
		},
		{
			label: 'intent type',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`intentType` = 'IssueCoupon'",
			target: 'wake',
		},
		{
			label: 'intent journey ID',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`journeyId` = 'evergreen-offer:corrupt'",
			target: 'wake',
		},
		{
			label: 'intent origin',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`originatingStimulusId` = 'stimulus_corrupt_origin'",
			target: 'wake',
		},
		{
			label: 'intent status',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`status` = 'Applied'",
			target: 'wake',
		},
		{
			label: 'intent settlement identity',
			table: 'AI_EvergreenOfferJourneyIntent',
			set: "`settledByStimulusId` = 'stimulus_corrupt_settlement'",
			target: 'wake',
		},
		{
			label: 'wake format',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`format` = 'evergreen-offer-journey.wake.v2'",
			target: 'entry',
		},
		{
			label: 'wake ID',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`wakeId` = CONCAT(`wakeId`, ':corrupt')",
			target: 'entry',
		},
		{
			label: 'wake ordinal',
			table: 'AI_EvergreenOfferJourneyWake',
			set: '`ordinal` = 9',
			target: 'entry',
		},
		{
			label: 'wake creation time',
			table: 'AI_EvergreenOfferJourneyWake',
			set: '`createdAt` = DATE_ADD(`createdAt`, INTERVAL 1 SECOND)',
			target: 'entry',
		},
		{
			label: 'wake update time',
			table: 'AI_EvergreenOfferJourneyWake',
			set: '`updatedAt` = DATE_ADD(`updatedAt`, INTERVAL 1 SECOND)',
			target: 'entry',
		},
		{
			label: 'wake purpose',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`purposeType` = 'CouponIssue'",
			target: 'entry',
		},
		{
			label: 'wake journey ID',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`journeyId` = 'evergreen-offer:corrupt'",
			target: 'entry',
		},
		{
			label: 'wake due time',
			table: 'AI_EvergreenOfferJourneyWake',
			set: '`dueAt` = DATE_ADD(`dueAt`, INTERVAL 1 SECOND)',
			target: 'entry',
		},
		{
			label: 'wake origin',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`originatingStimulusId` = 'stimulus_corrupt_origin'",
			target: 'entry',
		},
		{
			label: 'wake status',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`status` = 'Applied'",
			target: 'entry',
		},
		{
			label: 'wake settlement identity',
			table: 'AI_EvergreenOfferJourneyWake',
			set: "`settledByStimulusId` = 'stimulus_corrupt_settlement'",
			target: 'entry',
		},
	] as const)(
		'rejects corrupt duplicated scalar: $label',
		async ({ table, set, target }) => {
			const start = entry('stimulus_mysql_scalar_entry')
			await Effect.runPromise(first.ledger.commit(start.commit))
			const next = wakeCommit(
				start.decision.next,
				0,
				'stimulus_mysql_scalar_wake',
			)
			await Effect.runPromise(first.ledger.commit(next))
			await adminPool.query(
				`UPDATE \`${table}\` SET ${set} WHERE \`status\` = 'Pending' LIMIT 1`,
			)
			const stimulusId =
				target === 'entry'
					? start.stimulus.stimulusId
					: next.stimulus.stimulusId
			const result = await Effect.runPromise(
				Effect.either(second.ledger.findCommittedStimulus(stimulusId)),
			)
			expect(Either.isLeft(result)).toBe(true)
			if (Either.isLeft(result)) {
				expect(result.left.type).toBe('JourneyDecodeFailure')
			}
		},
	)

	it('allows one of two same-version wakes and rejects the stale contender', async () => {
		const start = entry('stimulus_mysql_version_entry')
		await Effect.runPromise(first.ledger.commit(start.commit))
		const firstWake = wakeCommit(
			start.decision.next,
			0,
			'stimulus_mysql_version_wake_1',
		)
		const secondWake = wakeCommit(
			start.decision.next,
			1,
			'stimulus_mysql_version_wake_2',
		)
		const results = await Promise.all([
			Effect.runPromise(Effect.either(first.ledger.commit(firstWake))),
			Effect.runPromise(Effect.either(second.ledger.commit(secondWake))),
		])
		expect(results.filter(Either.isRight)).toHaveLength(1)
		const failure = results.find(Either.isLeft)
		expect(
			failure && Either.isLeft(failure) ? failure.left : null,
		).toMatchObject({
			type: 'JourneyVersionConflict',
		})
	})

	it.each(deliveryScenarios)(
		'allows the owned missed-to-$expectedStatus late $name correction',
		async (scenario) => {
			const suffix = scenario.outcome.type
			const start = entry(`stimulus_mysql_late_${suffix}_entry`)
			await Effect.runPromise(first.ledger.commit(start.commit))
			const firstWake = wakeCommit(
				start.decision.next,
				0,
				`stimulus_mysql_late_${suffix}_b1`,
			)
			await Effect.runPromise(first.ledger.commit(firstWake))
			const firstIntent = firstWake.decision.sideEffectIntents[0]
			if (!firstIntent || firstIntent.type !== 'SendMessage') {
				throw new Error('Expected first message intent')
			}
			const secondWake = wakeCommit(
				firstWake.decision.next,
				1,
				`stimulus_mysql_late_${suffix}_b2`,
			)
			await Effect.runPromise(first.ledger.commit(secondWake))
			expect(await intentStatus(adminPool, firstIntent.idempotencyKey)).toBe(
				'Missed',
			)
			await Effect.runPromise(
				first.ledger.commit(
					deliveryCommit(
						secondWake.decision.next,
						firstIntent,
						`stimulus_mysql_late_${suffix}_settled`,
						scenario.outcome,
					),
				),
			)
			expect(await intentStatus(adminPool, firstIntent.idempotencyKey)).toBe(
				scenario.expectedStatus,
			)
		},
	)

	it('rolls back when a wake row was already settled out of band', async () => {
		const start = entry('stimulus_mysql_prewake_entry')
		await Effect.runPromise(first.ledger.commit(start.commit))
		const next = wakeCommit(
			start.decision.next,
			0,
			'stimulus_mysql_prewake_due',
		)
		if (next.stimulus.type !== 'WakeDue') throw new Error('Expected wake')
		await adminPool.query(
			`UPDATE \`AI_EvergreenOfferJourneyWake\`
			 SET \`status\` = 'Applied', \`settledByStimulusId\` = ?, \`settledAt\` = ?
			 WHERE \`wakeId\` = ?`,
			[
				start.stimulus.stimulusId,
				new Date(start.decision.transitionReceipt.committedAt),
				next.stimulus.wakeId,
			],
		)
		const result = await Effect.runPromise(
			Effect.either(first.ledger.commit(next)),
		)
		expect(Either.isLeft(result)).toBe(true)
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(1)
	})

	it('rolls back when an intent row was already settled out of band', async () => {
		const start = entry('stimulus_mysql_preintent_entry')
		await Effect.runPromise(first.ledger.commit(start.commit))
		const wake = wakeCommit(
			start.decision.next,
			0,
			'stimulus_mysql_preintent_wake',
		)
		await Effect.runPromise(first.ledger.commit(wake))
		const wakeDecision = wake.decision
		const intent = wakeDecision.sideEffectIntents[0]
		if (!intent || intent.type !== 'SendMessage') {
			throw new Error('Expected message intent')
		}
		const delivery = deliveryCommit(
			wakeDecision.next,
			intent,
			'stimulus_mysql_preintent_delivery',
		)
		await adminPool.query(
			`UPDATE \`AI_EvergreenOfferJourneyIntent\`
			 SET \`status\` = 'Refused', \`settledByStimulusId\` = ?, \`settledAt\` = ?
			 WHERE \`idempotencyKey\` = ?`,
			[
				wake.stimulus.stimulusId,
				new Date(wakeDecision.transitionReceipt.committedAt),
				intent.idempotencyKey,
			],
		)
		const result = await Effect.runPromise(
			Effect.either(first.ledger.commit(delivery)),
		)
		expect(Either.isLeft(result)).toBe(true)
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(2)
	})

	it('rejects a corrupt semantic-key owner without partial mutation', async () => {
		const start = entry('stimulus_mysql_semantic_entry')
		await Effect.runPromise(first.ledger.commit(start.commit))
		const next = wakeCommit(
			start.decision.next,
			0,
			'stimulus_mysql_semantic_wake',
		)
		const intent = next.decision.sideEffectIntents[0]
		const wakeId =
			next.stimulus.type === 'WakeDue' ? next.stimulus.wakeId : null
		if (!intent || intent.type !== 'SendMessage' || !wakeId) {
			throw new Error('Expected wake and message intent')
		}
		await adminPool.query(
			`INSERT INTO \`AI_EvergreenOfferJourneyIntent\`
			 (\`format\`, \`idempotencyKey\`, \`journeyId\`, \`originatingStimulusId\`, \`actorVersion\`, \`ordinal\`, \`intentType\`, \`intent\`, \`status\`, \`availableAt\`)
			 VALUES ('evergreen-offer-journey.intent.v1', ?, ?, ?, 1, 0, ?, ?, 'Pending', ?)`,
			[
				intent.idempotencyKey,
				start.decision.next.journeyId,
				start.stimulus.stimulusId,
				intent.type,
				JSON.stringify(intent),
				new Date(intent.notBefore),
			],
		)

		const result = await Effect.runPromise(
			Effect.either(first.ledger.commit(next)),
		)
		expect(Either.isLeft(result)).toBe(true)
		if (Either.isLeft(result)) {
			expect(result.left.type).toBe('JourneyDecodeFailure')
		}
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(1)
		expect(await wakeStatus(adminPool, wakeId)).toBe('Pending')
	})

	it('enforces semantic intent identity at the database boundary', async () => {
		const start = entry('stimulus_mysql_unique_entry')
		await Effect.runPromise(first.ledger.commit(start.commit))
		const wake = wakeCommit(
			start.decision.next,
			0,
			'stimulus_mysql_unique_wake',
		)
		await Effect.runPromise(first.ledger.commit(wake))
		const intent = wake.decision.sideEffectIntents[0]
		if (!intent) throw new Error('Expected intent')
		await expect(
			adminPool.query(
				`INSERT INTO \`AI_EvergreenOfferJourneyIntent\`
				 SELECT \`format\`, \`idempotencyKey\`, \`journeyId\`, \`originatingStimulusId\`, 99, 0,
				        \`intentType\`, \`intent\`, \`status\`, \`availableAt\`, \`settledByStimulusId\`, \`settledAt\`,
				        \`createdAt\`, \`updatedAt\`
				 FROM \`AI_EvergreenOfferJourneyIntent\`
				 WHERE \`idempotencyKey\` = ?`,
				[intent.idempotencyKey],
			),
		).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
	})

	it('rolls back the commit claim when a later wake insert fails', async () => {
		await adminPool.query('DROP TABLE `AI_EvergreenOfferJourneyWake`')
		const result = await Effect.runPromise(
			Effect.either(
				first.ledger.commit(entry('stimulus_mysql_rollback').commit),
			),
		)
		expect(Either.isLeft(result)).toBe(true)
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(0)
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyIntent')).toBe(0)
		await adminPool.query(migration)
		expect(
			(
				await Effect.runPromise(
					first.ledger.commit(entry('after-rollback').commit),
				)
			).committed,
		).toBe(true)
	})

	it('hard-stops mutation when the current commit is corrupt', async () => {
		const start = entry('stimulus_mysql_corrupt_head')
		await Effect.runPromise(first.ledger.commit(start.commit))
		const next = wakeCommit(
			start.decision.next,
			0,
			'stimulus_mysql_corrupt_head_next',
		)
		await adminPool.query(
			"UPDATE `AI_EvergreenOfferJourneyCommit` SET `commitEvidence` = JSON_SET(`commitEvidence`, '$.currentFacts.evidenceVersion', 'corrupt') WHERE `stimulusId` = ?",
			[start.stimulus.stimulusId],
		)
		const result = await Effect.runPromise(
			Effect.either(second.ledger.commit(next)),
		)
		expect(Either.isLeft(result)).toBe(true)
		if (Either.isLeft(result)) {
			expect(result.left.type).toBe('JourneyDecodeFailure')
		}
		expect(await countRows(adminPool, 'AI_EvergreenOfferJourneyCommit')).toBe(1)
	})

	it('refuses replay when the commit row format is unsupported', async () => {
		const start = entry('stimulus_mysql_commit_format')
		await Effect.runPromise(first.ledger.commit(start.commit))
		await adminPool.query(
			"UPDATE `AI_EvergreenOfferJourneyCommit` SET `format` = 'evergreen-offer-journey.commit.v2' WHERE `stimulusId` = ?",
			[start.stimulus.stimulusId],
		)
		const result = await Effect.runPromise(
			Effect.either(
				second.ledger.findCommittedStimulus(start.stimulus.stimulusId),
			),
		)
		expect(Either.isLeft(result)).toBe(true)
		if (Either.isLeft(result)) {
			expect(result.left.type).toBe('JourneyDecodeFailure')
		}
	})

	it.each([
		"`stimulusType` = 'WakeDue'",
		'`decidedAt` = DATE_ADD(`decidedAt`, INTERVAL 1 SECOND)',
		'`committedAt` = DATE_ADD(`committedAt`, INTERVAL 1 SECOND)',
		"`commitEvidence` = JSON_REMOVE(`commitEvidence`, '$.currentFacts')",
		"`commitEvidence` = JSON_SET(`commitEvidence`, '$.stimulus.valuePathId', 'corrupt-value-path')",
		"`commitEvidence` = JSON_SET(`commitEvidence`, '$.currentFacts.evidenceVersion', 'corrupt-facts')",
		"`commitEvidence` = JSON_SET(`commitEvidence`, '$.definition.contentRevision', 'corrupt-revision')",
	] as const)('refuses corrupt commit evidence: %s', async (set) => {
		const start = entry('stimulus_mysql_commit_evidence')
		await Effect.runPromise(first.ledger.commit(start.commit))
		await adminPool.query(
			`UPDATE \`AI_EvergreenOfferJourneyCommit\` SET ${set} WHERE \`stimulusId\` = ?`,
			[start.stimulus.stimulusId],
		)
		const result = await Effect.runPromise(
			Effect.either(
				second.ledger.findCommittedStimulus(start.stimulus.stimulusId),
			),
		)
		expect(Either.isLeft(result)).toBe(true)
		if (Either.isLeft(result)) {
			expect(result.left.type).toBe('JourneyDecodeFailure')
		}
	})

	it('refuses replay when normalized journal records disagree with decision JSON', async () => {
		const start = entry('stimulus_mysql_corrupt')
		await Effect.runPromise(first.ledger.commit(start.commit))
		await adminPool.query(
			"UPDATE `AI_EvergreenOfferJourneyCommit` SET `decision` = JSON_SET(`decision`, '$.next.version', 999) WHERE `stimulusId` = ?",
			[start.stimulus.stimulusId],
		)
		const result = await Effect.runPromise(
			Effect.either(
				second.ledger.findCommittedStimulus(start.stimulus.stimulusId),
			),
		)
		expect(Either.isLeft(result)).toBe(true)
		if (Either.isLeft(result)) {
			expect(result.left.type).toBe('JourneyDecodeFailure')
		}
	})
})

async function expectRowFormat(
	pool: Pool,
	table: (typeof tableNames)[number],
	expected: string,
) {
	const [rows] = await pool.query<Array<RowDataPacket & { format: string }>>(
		`SELECT DISTINCT \`format\` FROM \`${table}\``,
	)
	expect(rows.map((row) => row.format)).toEqual([expected])
}

async function intentStatus(pool: Pool, idempotencyKey: string) {
	const [rows] = await pool.query<Array<RowDataPacket & { status: string }>>(
		'SELECT `status` FROM `AI_EvergreenOfferJourneyIntent` WHERE `idempotencyKey` = ?',
		[idempotencyKey],
	)
	return rows[0]?.status ?? null
}

async function wakeStatus(pool: Pool, wakeId: string) {
	const [rows] = await pool.query<Array<RowDataPacket & { status: string }>>(
		'SELECT `status` FROM `AI_EvergreenOfferJourneyWake` WHERE `wakeId` = ?',
		[wakeId],
	)
	return rows[0]?.status ?? null
}

async function countRows(pool: Pool, table: (typeof tableNames)[number]) {
	const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
		`SELECT COUNT(*) AS count FROM \`${table}\``,
	)
	return Number(rows[0]?.count ?? 0)
}

function instant(input: string) {
	return value(parseIsoInstant(input))
}

function value<Value>(result: ParseResult<Value>): Value {
	if (!result.ok) throw new Error(result.error.reason)
	return result.value
}
