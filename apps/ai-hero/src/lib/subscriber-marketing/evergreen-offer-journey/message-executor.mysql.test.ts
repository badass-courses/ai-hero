import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import * as mysqlQueryClient from '@/db/mysql-query-client'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { Effect, Either } from 'effect'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type {
	CourseSequenceExhausted,
	EligibilityFacts,
	SendMessageIntent,
} from './domain'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import {
	createMessageIntentExecutor,
	type DeliveryMembershipEvidence,
} from './message-executor'
import type { DeliveryPort, EvergreenOfferJourneyService } from './ports'
import {
	parseContactId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type IsoInstant,
	type ParseResult,
} from './primitives'
import { createEvergreenOfferJourneyService } from './service'

const mysqlServerUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const tableNames = [
	'AI_EvergreenOfferJourneyAttempt',
	'AI_EvergreenOfferJourneyWake',
	'AI_EvergreenOfferJourneyIntent',
	'AI_EvergreenOfferJourneyCommit',
] as const

function value<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error('Invalid test fixture')
	return result.value
}
const at = value(parseIsoInstant('2026-09-04T17:00:00.000Z'))
const contactId = value(parseContactId('contact_mysql_executor'))
const entry: CourseSequenceExhausted = {
	type: 'CourseSequenceExhausted',
	stimulusId: value(parseStimulusId('entry_mysql_executor')),
	entryFactId: value(parseEntryFactId('entry_mysql_executor')),
	contactId,
	valuePathId: 'ai-hero-skills-workflow-individual-v1',
	exhaustedAt: at,
	deadlineTimeZone: {
		type: 'ExplicitFallback',
		reason: 'header-missing',
		timeZone: value(parseIanaTimeZone('America/Los_Angeles')),
		capturedAt: at,
	},
	sourceReference: 'side-effect-intent:prior-intent',
}
const plus = (instant: string, ms: number) =>
	value(parseIsoInstant(new Date(Date.parse(instant) + ms).toISOString()))
const unpaged = <Item, Error>(
	page: Effect.Effect<{ readonly results: readonly Item[] }, Error>,
) => Effect.map(page, (loaded) => loaded.results)

function createConnection(uri: string) {
	const pool = mysqlQueryClient.preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 2, timezone: 'Z' }),
	)
	const database = drizzle(pool, {
		schema: journeySchema,
		mode: 'planetscale',
	})
	return {
		pool,
		database,
		ledger: createDrizzleJourneyLedger(database),
		attempts: createDrizzleJourneyAttempts(database),
	}
}

integration('SendMessage executor over MySQL attempts and ledger', () => {
	let serverPool: Pool
	let adminPool: Pool
	let first: ReturnType<typeof createConnection>
	let second: ReturnType<typeof createConnection>
	let databaseName: string
	let now: IsoInstant = at

	const clock = { now: Effect.sync(() => now) }
	const authority = {
		currentFacts: ({ journeyId }: { journeyId: string | null }) =>
			Effect.sync(
				(): EligibilityFacts => ({
					contactId,
					purchase: null,
					delivery: { type: 'Eligible' },
					existingJourneyId: journeyId as EligibilityFacts['existingJourneyId'],
					automationControl: { type: 'Enabled', version: 'control-v1' },
					evidenceVersion: 'facts-v1',
					readAt: now,
				}),
			),
	}
	const service = () =>
		createEvergreenOfferJourneyService({
			ledger: first.ledger,
			authority,
			clock,
			definition: EVERGREEN_OFFER_JOURNEY_V1,
		})
	const applied: SendMessageIntent[] = []
	let gate: Promise<void> = Promise.resolve()
	const delivery: DeliveryPort = {
		apply: (intent) =>
			Effect.promise(async () => {
				applied.push(intent)
				await gate
				return { providerReceiptId: 'fake:accepted', appliedAt: now }
			}),
	}
	let membership: DeliveryMembershipEvidence = {
		type: 'Absent',
		meaning: 'complete-read-not-resend-permission',
	}
	const reconciliation = {
		inspect: () => Effect.sync(() => membership),
	}
	const executor = (
		connection: ReturnType<typeof createConnection>,
		overrides: Partial<Parameters<typeof createMessageIntentExecutor>[0]> = {},
	) =>
		createMessageIntentExecutor({
			ledger: connection.ledger,
			service: service(),
			authority,
			clock,
			attempts: connection.attempts,
			delivery,
			reconciliation,
			leaseMs: 60_000,
			...overrides,
		})

	const persistedB1Intent = () => persistedIntent(0)
	/** Wakes bridge slot `index` at its due instant and returns its persisted intent. */
	async function persistedIntent(index: number): Promise<SendMessageIntent> {
		const started = await Effect.runPromise(service().advance(entry))
		if (started.decision.type !== 'Accepted') throw new Error('Expected entry')
		const wake = started.decision.wakeIntents[index]!
		now = wake.dueAt
		const woke = await Effect.runPromise(
			service().advance({
				type: 'WakeDue',
				stimulusId: value(
					parseStimulusId(
						index === 0 ? 'due_mysql_executor' : `due_mysql_executor_${index}`,
					),
				),
				journeyId: wake.journeyId,
				wakeId: wake.wakeId,
				dueAt: wake.dueAt,
				purpose: wake.purpose,
			}),
		)
		if (woke.decision.type !== 'Accepted') throw new Error('Expected wake')
		const intent = woke.decision.sideEffectIntents.find(
			(candidate): candidate is SendMessageIntent =>
				candidate.type === 'SendMessage',
		)
		if (!intent) throw new Error('Expected SendMessage intent')
		return intent
	}
	const attemptRow = (intent: SendMessageIntent) =>
		first.database.query.evergreenOfferJourneyAttempt.findFirst({
			where: eq(
				journeySchema.evergreenOfferJourneyAttempt.idempotencyKey,
				intent.idempotencyKey,
			),
		})
	const intentRow = (intent: SendMessageIntent) =>
		first.database.query.evergreenOfferJourneyIntent.findFirst({
			where: eq(
				journeySchema.evergreenOfferJourneyIntent.idempotencyKey,
				intent.idempotencyKey,
			),
		})

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
		databaseName = `aih_evergreen_executor_test_${randomUUID().replaceAll('-', '')}`
		await serverPool.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
		)
		const databaseUrl = new URL(safeServerUrl)
		databaseUrl.pathname = `/${databaseName}`
		adminPool = mysql.createPool({
			uri: databaseUrl.toString(),
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		for (const migration of [
			'20260831_ai_hero_email_course_evergreen_schema.sql',
			'20260907_evergreen_admission_attempts.sql',
		]) {
			await adminPool.query(
				await fs.readFile(
					new URL(`../../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		}
		first = createConnection(databaseUrl.toString())
		second = createConnection(databaseUrl.toString())
	})

	beforeEach(async () => {
		for (const table of tableNames) {
			await adminPool.query(`DELETE FROM \`${table}\``)
		}
		now = at
		applied.length = 0
		gate = Promise.resolve()
		membership = {
			type: 'Absent',
			meaning: 'complete-read-not-resend-permission',
		}
	})

	afterAll(async () => {
		await first.pool.end()
		await second.pool.end()
		await adminPool.end()
		await serverPool.query(`DROP DATABASE \`${databaseName}\``)
		await serverPool.end()
	})

	it('lets exactly one of two executors on separate connections apply', async () => {
		const intent = await persistedB1Intent()
		let release!: () => void
		gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const winnerRun = Effect.runPromise(
			executor(first).execute({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
			}),
		)
		const loserRun = new Promise<Awaited<typeof winnerRun>>((resolve) => {
			setTimeout(() => {
				void Effect.runPromise(
					executor(second).execute({
						idempotencyKey: intent.idempotencyKey,
						journeyId: intent.journeyId,
					}),
				).then(resolve)
			}, 150)
		})
		setTimeout(release, 600)
		const [winner, loser] = await Promise.all([winnerRun, loserRun])
		expect(winner).toMatchObject({
			type: 'Applied',
			meaning: 'provider-accepted-not-inbox-delivery',
			settlement: { type: 'Committed' },
		})
		expect(loser).toEqual({
			type: 'AlreadyAttempted',
			state: 'Claimed',
			sideEffects: 'none',
		})
		expect(applied).toHaveLength(1)
		expect(await attemptRow(intent)).toMatchObject({
			status: 'Accepted',
			outcome: { type: 'Accepted', providerReceiptId: 'fake:accepted' },
		})
		expect(await intentRow(intent)).toMatchObject({ status: 'Applied' })
		const again = await Effect.runPromise(
			executor(second).execute({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
			}),
		)
		expect(again).toEqual({
			type: 'NotClaimed',
			reason: 'IntentNotPending',
			sideEffects: 'none',
		})
		expect(applied).toHaveLength(1)
	})

	it('recovers a crash between attempt acceptance and domain commit without resending', async () => {
		const intent = await persistedB1Intent()
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: () =>
				Effect.fail({
					type: 'JourneyCommitUnavailable' as const,
					reason: 'process died',
				}),
		}
		const crashed = await Effect.runPromise(
			executor(first, { service: crashing }).execute({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
			}),
		)
		expect(crashed).toMatchObject({
			type: 'Applied',
			settlement: { type: 'Failed', error: 'JourneyCommitUnavailable' },
		})
		expect(await attemptRow(intent)).toMatchObject({ status: 'Accepted' })
		expect(await intentRow(intent)).toMatchObject({ status: 'Pending' })

		now = plus(now, 120_000)
		const recovered = await Effect.runPromise(
			unpaged(executor(second).settleRecordedOutcomes({ limit: 10 })),
		)
		const attempt = await attemptRow(intent)
		expect(recovered).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				attemptStatus: 'Accepted',
				settlement: {
					type: 'Committed',
					stimulusId: `${intent.idempotencyKey}:attempt:${attempt?.claimToken}:delivery-settled`,
				},
			},
		])
		expect(await intentRow(intent)).toMatchObject({ status: 'Applied' })
		const loaded = await Effect.runPromise(second.ledger.load(intent.journeyId))
		expect(
			loaded?.messagePlan.bridge.find((slot) => slot.slotId === intent.slotId),
		).toMatchObject({ status: 'Applied', providerReceiptId: 'fake:accepted' })
		expect(
			await Effect.runPromise(
				unpaged(executor(second).settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])
		expect(applied).toHaveLength(1)
	})

	it('reconciles an expired claim only from positive GET-only membership', async () => {
		const intent = await persistedB1Intent()
		const claimed = await Effect.runPromise(
			first.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now: new Date(now),
				leaseExpiresAt: new Date(Date.parse(now) + 1_000),
			}),
		)
		if (claimed.type !== 'Claimed') throw new Error('Expected claim')
		now = plus(now, 5_000)
		expect(
			await Effect.runPromise(
				executor(second).execute({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
				}),
			),
		).toEqual({
			type: 'AlreadyAttempted',
			state: 'HeldUncertain',
			sideEffects: 'none',
		})
		const absent = await Effect.runPromise(
			unpaged(executor(second).reconcileHeld({ limit: 10 })),
		)
		expect(absent[0]?.result).toEqual({
			type: 'AbsentHeld',
			meaning: 'not-resend-permission',
		})
		expect(await attemptRow(intent)).toMatchObject({ status: 'Claimed' })

		// Real provider membership that predates this claim is held, never retimed.
		membership = {
			type: 'Present',
			providerReceiptId: 'kit:sequence-membership-observed:b1',
			addedAt: plus(claimed.evidence.claimedAt.toISOString(), -1),
			observedAt: now,
		}
		const prior = await Effect.runPromise(
			unpaged(executor(second).reconcileHeld({ limit: 10 })),
		)
		expect(prior[0]?.result).toMatchObject({
			type: 'MembershipHeld',
			reason: 'PrecedesClaim',
		})
		expect(await attemptRow(intent)).toMatchObject({ status: 'Claimed' })

		const addedAt = plus(claimed.evidence.claimedAt.toISOString(), 1_000)
		membership = {
			type: 'Present',
			providerReceiptId: 'kit:sequence-membership-observed:b1',
			addedAt,
			observedAt: now,
		}
		const present = await Effect.runPromise(
			unpaged(executor(second).reconcileHeld({ limit: 10 })),
		)
		expect(present[0]).toMatchObject({
			result: {
				type: 'ReconciledAccepted',
				addedAt,
				settlement: { type: 'Committed' },
			},
			sideEffects: 'attempt-recorded',
		})
		expect(await attemptRow(intent)).toMatchObject({
			status: 'Accepted',
			claimToken: claimed.evidence.claimToken,
			outcome: { type: 'Accepted', appliedAt: addedAt },
		})
		expect(await intentRow(intent)).toMatchObject({ status: 'Applied' })
		expect(applied).toHaveLength(0)
		expect(
			Either.isRight(
				await Effect.runPromise(
					Effect.either(unpaged(executor(second).reconcileHeld({ limit: 10 }))),
				),
			),
		).toBe(true)
	})
	it('pages held claims past a retained first page through the real attempt store', async () => {
		const intents: SendMessageIntent[] = []
		for (const index of [0, 1, 2]) {
			const intent = await persistedIntent(index)
			intents.push(intent)
			const claimed = await Effect.runPromise(
				first.attempts.claim({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					now: new Date(now),
					leaseExpiresAt: new Date(Date.parse(now) + 1_000),
				}),
			)
			if (claimed.type !== 'Claimed') throw new Error('Expected claim')
		}
		const keys = intents.map((intent) => intent.idempotencyKey)
		now = plus(now, 5_000)
		const page = await Effect.runPromise(
			executor(second).reconcileHeld({ limit: 2 }),
		)
		expect(page.results.map((item) => item.idempotencyKey)).toEqual([
			keys[0],
			keys[1],
		])
		expect(page.results.map((item) => item.result.type)).toEqual([
			'AbsentHeld',
			'AbsentHeld',
		])
		expect(page).toMatchObject({
			scanned: 2,
			end: false,
			nextCursor: { idempotencyKey: keys[1] },
		})
		if (!page.nextCursor) throw new Error('Expected a cursor')
		// The retained first page is re-read without a cursor; with it, later rows surface.
		expect(
			(
				await Effect.runPromise(executor(second).reconcileHeld({ limit: 2 }))
			).results.map((item) => item.idempotencyKey),
		).toEqual([keys[0], keys[1]])
		const continued = await Effect.runPromise(
			executor(second).reconcileHeld({ limit: 2, after: page.nextCursor }),
		)
		expect(continued.results.map((item) => item.idempotencyKey)).toEqual([
			keys[2],
		])
		expect(continued).toMatchObject({
			scanned: 1,
			end: true,
			nextCursor: { idempotencyKey: keys[2] },
		})
		if (!continued.nextCursor) throw new Error('Expected a cursor')
		expect(
			await Effect.runPromise(
				executor(second).reconcileHeld({
					limit: 2,
					after: continued.nextCursor,
				}),
			),
		).toEqual({
			results: [],
			scanned: 0,
			end: true,
			nextCursor: continued.nextCursor,
		})
		for (const intent of intents)
			expect(await attemptRow(intent)).toMatchObject({ status: 'Claimed' })
		expect(applied).toHaveLength(0)
	})

	it('pages recorded outcomes past a retained first page through the real attempt store', async () => {
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: () =>
				Effect.fail({
					type: 'JourneyCommitUnavailable' as const,
					reason: 'process died',
				}),
		}
		const intents: SendMessageIntent[] = []
		for (const index of [0, 1, 2]) {
			const intent = await persistedIntent(index)
			intents.push(intent)
			expect(
				await Effect.runPromise(
					executor(first, { service: crashing }).execute({
						idempotencyKey: intent.idempotencyKey,
						journeyId: intent.journeyId,
					}),
				),
			).toMatchObject({
				type: 'Applied',
				settlement: { type: 'Failed', error: 'JourneyCommitUnavailable' },
			})
		}
		const keys = intents.map((intent) => intent.idempotencyKey)
		now = plus(now, 120_000)
		const stuck = await Effect.runPromise(
			executor(second, { service: crashing }).settleRecordedOutcomes({
				limit: 2,
			}),
		)
		expect(stuck.results.map((item) => item.idempotencyKey)).toEqual([
			keys[0],
			keys[1],
		])
		expect(stuck.results.map((item) => item.settlement.type)).toEqual([
			'Failed',
			'Failed',
		])
		expect(stuck).toMatchObject({
			scanned: 2,
			end: false,
			nextCursor: { status: 'Accepted', idempotencyKey: keys[1] },
		})
		if (!stuck.nextCursor) throw new Error('Expected a cursor')
		const later = await Effect.runPromise(
			executor(second).settleRecordedOutcomes({
				limit: 2,
				after: stuck.nextCursor,
			}),
		)
		const third = await attemptRow(intents[2]!)
		expect(later.results).toEqual([
			{
				idempotencyKey: keys[2],
				journeyId: intents[2]!.journeyId,
				attemptStatus: 'Accepted',
				settlement: {
					type: 'Committed',
					stimulusId: `${keys[2]}:attempt:${third?.claimToken}:delivery-settled`,
				},
			},
		])
		expect(later).toMatchObject({ scanned: 1, end: true })
		expect(await intentRow(intents[2]!)).toMatchObject({ status: 'Applied' })
		expect(await intentRow(intents[0]!)).not.toMatchObject({
			status: 'Applied',
		})
		// A restart from no cursor settles the rows the retained page left behind.
		const restart = await Effect.runPromise(
			executor(second).settleRecordedOutcomes({ limit: 2 }),
		)
		expect(
			restart.results.map((item) => [
				item.idempotencyKey,
				item.settlement.type,
			]),
		).toEqual([
			[keys[0], 'Committed'],
			[keys[1], 'Committed'],
		])
		expect(
			await Effect.runPromise(
				unpaged(executor(second).settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])
		for (const intent of intents)
			expect(await intentRow(intent)).toMatchObject({ status: 'Applied' })
		expect(applied).toHaveLength(3)
	})
	it('stores the observed instant of a live permanent refusal and reads it back unchanged', async () => {
		const intent = await persistedB1Intent()
		let posts = 0
		const refusing: DeliveryPort = {
			apply: () =>
				Effect.suspend(() => {
					posts++
					return Effect.fail({
						type: 'EffectPermanentRefusal' as const,
						reason: 'kit-enrollment-http-422',
					})
				}),
		}
		const observedAt = now
		const result = await Effect.runPromise(
			executor(first, { delivery: refusing }).execute({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
			}),
		)
		expect(result).toMatchObject({
			type: 'Refused',
			refusal: 'ProviderRefused',
			applyInvocations: 1,
			settlement: { type: 'Committed' },
		})
		expect(posts).toBe(1)
		const row = await attemptRow(intent)
		expect(row).toMatchObject({
			status: 'KnownNotApplied',
			outcome: {
				type: 'KnownNotApplied',
				reason: 'ProviderRefused',
				observedAt,
			},
		})
		expect(await intentRow(intent)).toMatchObject({ status: 'Refused' })
		const loaded = await Effect.runPromise(second.ledger.load(intent.journeyId))
		expect(
			loaded?.messagePlan.bridge.find((slot) => slot.slotId === intent.slotId),
		).toMatchObject({ status: 'Refused', settledAt: observedAt })
		// Read back through the other connection's page decoder: same bytes, no rewrite.
		now = plus(now, 120_000)
		expect(
			await Effect.runPromise(
				unpaged(executor(second).settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])
		expect(await attemptRow(intent)).toEqual(row)
		expect(
			await Effect.runPromise(
				executor(second, { delivery: refusing }).execute({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
				}),
			),
		).toEqual({
			type: 'NotClaimed',
			reason: 'IntentNotPending',
			sideEffects: 'none',
		})
		expect(posts).toBe(1)
	})

	it('recovers a crashed permanent refusal at the stored observation, not the recovery clock', async () => {
		const intent = await persistedB1Intent()
		const refusing: DeliveryPort = {
			apply: () =>
				Effect.fail({
					type: 'EffectPermanentRefusal' as const,
					reason: 'kit-enrollment-http-422',
				}),
		}
		const crashing: Pick<EvergreenOfferJourneyService, 'advance'> = {
			advance: () =>
				Effect.fail({
					type: 'JourneyCommitUnavailable' as const,
					reason: 'process died',
				}),
		}
		const observedAt = now
		expect(
			await Effect.runPromise(
				executor(first, { delivery: refusing, service: crashing }).execute({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
				}),
			),
		).toMatchObject({
			type: 'Refused',
			settlement: { type: 'Failed', error: 'JourneyCommitUnavailable' },
		})
		const row = await attemptRow(intent)
		expect(row).toMatchObject({
			status: 'KnownNotApplied',
			outcome: {
				type: 'KnownNotApplied',
				reason: 'ProviderRefused',
				observedAt,
			},
		})
		expect(await intentRow(intent)).toMatchObject({ status: 'Pending' })
		now = plus(now, 120_000)
		const recovered = await Effect.runPromise(
			unpaged(executor(second).settleRecordedOutcomes({ limit: 10 })),
		)
		expect(recovered).toEqual([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				attemptStatus: 'KnownNotApplied',
				settlement: {
					type: 'Committed',
					stimulusId: `${intent.idempotencyKey}:attempt:${row?.claimToken}:delivery-settled`,
				},
			},
		])
		expect(await intentRow(intent)).toMatchObject({ status: 'Refused' })
		const loaded = await Effect.runPromise(second.ledger.load(intent.journeyId))
		expect(
			loaded?.messagePlan.bridge.find((slot) => slot.slotId === intent.slotId),
		).toMatchObject({ status: 'Refused', settledAt: observedAt })
		expect(await attemptRow(intent)).toEqual(row)
		expect(
			await Effect.runPromise(
				unpaged(executor(second).settleRecordedOutcomes({ limit: 10 })),
			),
		).toEqual([])
		expect(applied).toHaveLength(0)
	})
})
