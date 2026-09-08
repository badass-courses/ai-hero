import { randomUUID } from 'node:crypto'
import { createBridgeRuntime, type BridgeRuntimeDependencies } from './bridge-runtime'
import { createBoundedJourneyReaders } from './bounded-readers'
import fs from 'node:fs/promises'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { contactEvent, providerIdentity } from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { eq, sql as sqlBuilder } from 'drizzle-orm'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import { drizzle } from 'drizzle-orm/mysql2'
import { Effect, Either } from 'effect'
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import {
	fixtureEntry,
	fixtureWake,
	sourceFixture,
} from './bounded-readers.fixtures'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import { createEvergreenOfferJourneyService } from './service'
import { createRevisionDelivery } from './revision-delivery'
import { syntheticRevisionScope } from './revision-delivery.fixtures'
import {
	createMySqlOriginalMappingPersistence,
	createOriginalDeliveryMapping,
	type OriginalMappingPersistence,
} from './original-delivery-mapping-mysql'
import {
	mappingIdentity,
	readMappingEventRow,
} from './original-delivery-mapping'
import { decodeAttempt, type AttemptEvidence } from './attempt-evidence'
import type { EligibilityFacts, SendMessageIntent } from './domain'
import type { IsoInstant } from './primitives'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
function connect(uri: string, readOnly = false) {
	// Wrap the underlying driver before instrumenting it. Wrapping the proxy
	// itself replaces raw.query with a captured, already-instrumented query and
	// counts each driver call twice.
	const raw = preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 2, timezone: 'Z' }),
	)
	const queries: string[] = []
	const connections = new WeakMap<PoolConnection, PoolConnection>()
	function guardConnection(connection: PoolConnection): PoolConnection {
		const existing = connections.get(connection)
		if (existing) return existing
		// Shape the raw connection before wrapping, just like the pool. Cache both
		// identities so reacquisition/re-entry cannot nest query instrumentation.
		const guarded = guard(preserveQueryResultShape(connection))
		connections.set(connection, guarded)
		connections.set(guarded, guarded)
		return guarded
	}
	function guard<T extends Pool | PoolConnection>(client: T): T {
		return new Proxy(client, {
			get(target, key) {
				if (key === 'getConnection' && 'getConnection' in target) {
					return async () => guardConnection(await target.getConnection())
				}
				const member = Reflect.get(target, key)
				if (typeof member !== 'function') return member
				return (...args: unknown[]) => {
					if (key === 'query' || key === 'execute') {
						const first = args[0]
						const text =
							typeof first === 'string'
								? first
								: first && typeof first === 'object' && 'sql' in first
									? String(first.sql)
									: ''
						queries.push(text)
						if (
							readOnly &&
							/\b(insert|update|delete)\b[\s\S]*AI_ContactEvent/i.test(text)
						)
							throw new Error('Recovery ContactEvent mutation denied')
					}
					return Reflect.apply(member, target, args)
				}
			},
		})
	}
	const database = drizzle(guard(raw), {
		schema: journeySchema,
		mode: 'planetscale',
	})
	return {
		pool: raw,
		database,
		queries,
		ledger: createDrizzleJourneyLedger(database),
		attempts: createDrizzleJourneyAttempts(database),
		store: createMySqlOriginalMappingPersistence(database),
	}
}
integration(
	'real primary original mapping before fake Kit POST and read-only restart',
	() => {
		let server: Pool,
			admin: Pool,
			first: ReturnType<typeof connect>,
			second: ReturnType<typeof connect>,
			databaseName: string
		let now: string, intent: SendMessageIntent, base: EligibilityFacts
		let posts: number,
			gets: string[],
			failOutcome: boolean,
			noRequest: number,
			postStatus: number
		const manifest = () => syntheticRevisionScope().manifest
		const clock = { now: Effect.sync(() => now as IsoInstant) }
		const authority = {
			currentFacts: ({ journeyId }: { journeyId: string | null }) =>
				Effect.sync(() => ({
					...base,
					existingJourneyId: journeyId as EligibilityFacts['existingJourneyId'],
					readAt: now as IsoInstant,
				})),
		}
		const row = async () =>
			decodeAttempt(
				(
					await first.database
						.select()
						.from(journeySchema.evergreenOfferJourneyAttempt)
						.where(
							eq(
								journeySchema.evergreenOfferJourneyAttempt.idempotencyKey,
								intent.idempotencyKey,
							),
						)
				)[0],
			)
		const target = () => ({
			journeyId: intent.journeyId,
			idempotencyKey: intent.idempotencyKey,
		})
		const map = (store = first.store) =>
			createOriginalDeliveryMapping({ store, now: () => now })
		const claim = async () => {
			const result = await Effect.runPromise(
				first.attempts.claim({
					...target(),
					now: new Date(now),
					leaseExpiresAt: new Date(Date.parse(now) + 60_000),
				}),
			)
			if (result.type !== 'Claimed') throw new Error('Expected real claim')
			return result.evidence
		}
		const record = (
			attempt: AttemptEvidence,
			mapping = map(),
			selected = manifest(),
		) =>
			Effect.runPromise(
				mapping.writer.record({ attempt, intent, manifest: selected }),
			)
		function front(
			options: {
				mapping?: ReturnType<typeof map>
				connection?: ReturnType<typeof connect>
				writer?: boolean
				selected?: ReturnType<typeof manifest>
			} = {},
		) {
			const conn = options.connection ?? first,
				mapping = options.mapping ?? map(conn.store),
				selected = options.selected ?? manifest()
			const service = createEvergreenOfferJourneyService({
				ledger: conn.ledger,
				clock,
				authority,
				definition: EVERGREEN_OFFER_JOURNEY_V1,
			})
			return createRevisionDelivery({
				bundles: [
					{
						manifest: selected,
						originalMapping: mapping.reader,
						mappingWriter: options.writer === false ? null : mapping.writer,
						providerReadbacks: selected.messages.map((m) => ({
							sequenceId: m.sequenceId,
							repeat: false,
							emailCount: 1,
							published: true,
							active: true,
							hold: false,
						})),
					},
				],
				dependencies: {
					ledger: conn.ledger,
					authority,
					clock,
					service,
					attempts: {
						...conn.attempts,
						settle: (input) =>
							failOutcome
								? Effect.fail({
										type: 'AttemptUnavailable' as const,
										reason: 'synthetic lost outcome write',
									})
								: conn.attempts.settle(input),
					},
				},
				now: () => now,
				kit: {
					apiKey: 'synthetic-no-network',
					resolveIdentity: async (contactId) => {
						if (noRequest > 0) {
							noRequest--
							throw new Error('synthetic identity failure before request')
						}
						return { contactId, subscriberId: 91 }
					},
					fetch: (async (url, init) => {
						if (init?.method === 'GET') {
							gets.push(String(url))
							return new Response(
								JSON.stringify({
									subscribers:
										postStatus === 201 && posts > 0
											? [{ id: 91, state: 'active', added_at: now }]
											: [],
									pagination: {
										has_previous_page: false,
										has_next_page: false,
										end_cursor: '',
									},
								}),
								{ status: 200 },
							)
						}
						// Decisive assertion: another real connection sees this durable row BEFORE
						// fake HTTP can increment the POST count or return acknowledgment.
						const attempt = await row()
						const saved = await second.store.event(mappingIdentity(attempt).id)
						const core = readMappingEventRow(saved, {
							sourceEventId: 'mapping-source',
							providerIdentityId: 'identity-mapping-source',
						})
						expect(String(url)).toContain(`/sequences/${core.sequenceId}/`)
						expect(core.claimToken).toBe(attempt.claimToken)
						posts++
						return new Response(
							JSON.stringify({ subscriber: { id: 91, state: 'active' } }),
							{ status: postStatus },
						)
					}) as typeof fetch,
				},
			})
		}
		beforeAll(async () => {
			const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			})
			server = mysql.createPool({
				uri: safe.toString(),
				connectionLimit: 1,
				timezone: 'Z',
			})
			databaseName = `aih_mapping_test_${randomUUID().replaceAll('-', '')}`
			await server.query(
				`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
			)
			const uri = new URL(safe)
			uri.pathname = `/${databaseName}`
			admin = mysql.createPool({
				uri: uri.toString(),
				connectionLimit: 1,
				timezone: 'Z',
				multipleStatements: true,
			})
			for (const name of [
				'20260504_ai_hero_subscriber_marketing_gate_a.sql',
				'20260714_ai_hero_optin_attribution.sql',
				'20260717_ai_hero_side_effect_intent_completed_at.sql',
				'20260831_ai_hero_email_course_evergreen_schema.sql',
				'20260907_evergreen_admission_attempts.sql',
			])
				await admin.query(
					await fs.readFile(
						new URL(`../../../db/migrations/${name}`, import.meta.url),
						'utf8',
					),
				)
			first = connect(uri.toString())
			second = connect(uri.toString(), true)
		})
		beforeEach(async () => {
			for (const table of [
				'AI_EvergreenOfferJourneyAttempt',
				'AI_EvergreenOfferJourneyWake',
				'AI_EvergreenOfferJourneyIntent',
				'AI_EvergreenOfferJourneyCommit',
				'AI_ContactEvent',
				'AI_ProviderIdentity',
			])
				await admin.query(`DELETE FROM \`${table}\``)
			posts = 0
			gets = []
			failOutcome = false
			noRequest = 0
			postStatus = 201
			first.queries.length = 0
			second.queries.length = 0
			const source = sourceFixture('mapping-source')
			await first.database.insert(providerIdentity).values({
				id: source.providerIdentityId,
				contactId: source.contactId,
				provider: 'ai-hero',
				externalId: 'fixture-identity',
				evidence: { source: 'synthetic' },
			})
			await first.database.insert(contactEvent).values(source)
			const initial = fixtureEntry(source.id)
			await Effect.runPromise(first.ledger.commit(initial))
			const wake = fixtureWake(initial.decision.next, 0)
			await Effect.runPromise(first.ledger.commit(wake))
			const candidate = wake.decision.sideEffectIntents.find(
				(i): i is SendMessageIntent => i.type === 'SendMessage',
			)
			if (!candidate) throw new Error('Missing canonical message')
			intent = candidate
			now = wake.decidedAt
			base = wake.currentFacts
		})
		afterAll(async () => {
			await first?.pool.end()
			await second?.pool.end()
			await admin?.end()
			if (databaseName) await server.query(`DROP DATABASE \`${databaseName}\``)
			await server?.end()
		})
		function runtime(connection = first) {
			const service = createEvergreenOfferJourneyService({ ledger: connection.ledger, clock, authority, definition: EVERGREEN_OFFER_JOURNEY_V1 })
			// Coupon dispatch is intentionally outside this message integration fixture.
			const unexpected = () => { throw new Error('Unexpected coupon dispatch in message runtime test') }
			const coupons = { execute: unexpected, recoverRecordedPage: unexpected, recoverUncertainPage: unexpected } as BridgeRuntimeDependencies['coupons']
			return createBridgeRuntime({ clock, service, coupons, messages: front({ connection }), readers: createBoundedJourneyReaders(connection.database, connection.ledger), control: () => Effect.succeed({ type: 'Enabled', generation: 'runtime-fixture' }) })
		}
		it('runtime outbox page uses real claims/mapping and remains idempotent across independent runtimes', async () => {
			const request = { generation: 'runtime-fixture', lane: 'intents' as const }
			const results = await Promise.all([Effect.runPromise(runtime().tick(request)), Effect.runPromise(runtime().tick(request))])
			expect(results.some((r) => r.reason === 'Message:Applied')).toBe(true)
			expect(posts).toBe(1)
			expect((await row()).status).toBe('Accepted')
			await Effect.runPromise(runtime().tick(request))
			expect(posts).toBe(1)
		})
		it('runtime pause on lost outcome survives restart and recovery never posts again', async () => {
			failOutcome = true
			const result = await Effect.runPromise(runtime().tick({ generation: 'runtime-fixture', lane: 'intents' }))
			expect(result.type).toBe('Paused')
			expect(posts).toBe(1)
			failOutcome = false
			now = new Date(Date.parse(now) + 120_000).toISOString()
			const recovery = await Effect.runPromise(runtime().messageUncertain('runtime-fixture', {}))
			expect(recovery.type).toBe('RecoveryPage')
			expect(posts).toBe(1)
			expect(gets.length).toBeGreaterThan(0)
		})
		it('commits and independently verifies exact receipt before one fake HTTP POST', async () => {
			expect(await Effect.runPromise(front().execute(target()))).toMatchObject({
				type: 'Applied',
			})
			expect(posts).toBe(1)
			expect((await row()).status).toBe('Accepted')
			expect(
				first.queries.filter((q) => /insert into `AI_ContactEvent`/i.test(q)),
			).toHaveLength(2) // source + receipt
			expect(
				first.queries.filter((q) => /update `AI_ContactEvent`/i.test(q)),
			).toHaveLength(0)
		})
		it('identical concurrent writers/replay preserve one row and original recordedAt', async () => {
			const attempt = await claim(),
				other = map({ ...second.store, insert: first.store.insert })
			const results = await Promise.all([
				record(attempt),
				record(attempt, other),
			])
			expect(results.map((r) => r.type)).toEqual(['Verified', 'Verified'])
			expect(results[0]).toEqual(results[1])
			const before = await first.store.event(mappingIdentity(attempt).id)
			now = new Date(Date.parse(now) + 1000).toISOString()
			expect(await record(attempt)).toEqual(results[0])
			expect(await first.store.event(mappingIdentity(attempt).id)).toEqual(
				before,
			)
		})
		it('conflicting selection never overwrites winner', async () => {
			const attempt = await claim()
			expect((await record(attempt)).type).toBe('Verified')
			const before = await first.store.event(mappingIdentity(attempt).id)
			const changed = structuredClone(manifest())
			changed.messages[0]!.sequenceId += 99
			expect(await record(attempt, map(), changed)).toMatchObject({
				type: 'Held',
				reason: 'MappingConflict',
			})
			expect(await first.store.event(mappingIdentity(attempt).id)).toEqual(
				before,
			)
		})
		it.each([
			'identity-relink',
			'identity-missing',
			'source-contact',
			'source-type',
			'source-missing',
			'foreign-claim',
			'missing-attempt',
		] as const)(
			'holds real %s evidence before receipt write',
			async (fault) => {
				const attempt = await claim()
				if (fault === 'identity-relink')
					await first.database
						.update(providerIdentity)
						.set({ contactId: 'other' })
						.where(eq(providerIdentity.id, 'identity-mapping-source'))
				if (fault === 'identity-missing')
					await first.database
						.delete(providerIdentity)
						.where(eq(providerIdentity.id, 'identity-mapping-source'))
				if (fault === 'source-contact')
					await first.database
						.update(contactEvent)
						.set({ contactId: 'other' })
						.where(eq(contactEvent.id, 'mapping-source'))
				if (fault === 'source-type')
					await first.database
						.update(contactEvent)
						.set({ eventType: 'other' })
						.where(eq(contactEvent.id, 'mapping-source'))
				if (fault === 'source-missing')
					await first.database
						.delete(contactEvent)
						.where(eq(contactEvent.id, 'mapping-source'))
				if (fault === 'foreign-claim') attempt.claimToken = randomUUID()
				if (fault === 'missing-attempt')
					await first.database.delete(
						journeySchema.evergreenOfferJourneyAttempt,
					)
				expect(await record(attempt)).toMatchObject({ type: 'Held' })
				expect(await first.store.event(mappingIdentity(attempt).id)).toBeNull()
				expect(posts).toBe(0)
			},
		)
		it.each(['exact', 'missing', 'unavailable', 'conflicting'] as const)(
			'lost INSERT acknowledgment uses one fresh readback: %s',
			async (outcome) => {
				let verifies = 0
				const real = first.store
				const mapping = map({
					...real,
					insert: async (row) => {
						if (outcome !== 'missing') await real.insert(row)
						throw new Error('autocommit acknowledged by server, response lost')
					},
					event: async (id) => {
						if (!id.startsWith('eodm_')) return real.event(id)
						verifies++
						if (outcome === 'unavailable') throw new Error('readback down')
						const saved = await real.event(id)
						return outcome === 'conflicting' && saved
							? { ...saved, providerReference: 'other' }
							: saved
					},
				})
				const result = await Effect.runPromise(
					front({ mapping }).execute(target()),
				)
				expect(verifies).toBe(1)
				expect(posts).toBe(outcome === 'exact' ? 1 : 0)
				expect(result).toMatchObject(
					outcome === 'exact'
						? { type: 'Applied' }
						: { type: 'Abandoned', sideEffects: 'mapping-may-have-persisted' },
				)
			},
		)
		it('no-request retry keeps one receipt and one mutating POST', async () => {
			noRequest = 1
			const result = await Effect.runPromise(front().execute(target()))
			expect(result).toMatchObject({ type: 'Applied', applyInvocations: 2 })
			expect(posts).toBe(1)
			const attempt = await row(),
				before = await second.store.event(mappingIdentity(attempt).id)
			expect(await Effect.runPromise(front().execute(target()))).toMatchObject({
				type: 'NotClaimed',
				reason: 'IntentNotPending',
				sideEffects: 'none',
			})
			expect(posts).toBe(1)
			expect(await row()).toEqual(attempt)
			expect(await second.store.event(mappingIdentity(attempt).id)).toEqual(
				before,
			)
		})
		it.each(['before-receipt', 'before-post', 'after-ack'] as const)(
			'restart with SQL-only historical reader after crash %s never resends',
			async (crash) => {
				if (crash === 'after-ack') {
					failOutcome = true
					expect(
						Either.isLeft(
							await Effect.runPromise(Effect.either(front().execute(target()))),
						),
					).toBe(true)
					expect(posts).toBe(1)
					failOutcome = false
				} else {
					const attempt = await claim()
					if (crash === 'before-post')
						expect((await record(attempt)).type).toBe('Verified')
				}
				const before = await row(),
					receiptBefore = await second.store.event(mappingIdentity(before).id)
				now = new Date(before.leaseExpiresAt.getTime() + 1000).toISOString()
				// Brand-new handle/reader, writer absent. The recovery connection rejects all
				// ContactEvent mutations while permitting ordinary attempt settlement.
				const recovered = front({ connection: second, writer: false })
				const result = await Effect.runPromise(
					recovered.reconcileHeld({ limit: 20 }),
				)
				expect(JSON.stringify(result)).toContain(
					crash === 'before-receipt'
						? 'OriginalMappingUnavailable'
						: crash === 'before-post'
							? 'Held'
							: 'Reconciled',
				)
				expect(posts).toBe(crash === 'after-ack' ? 1 : 0)
				expect(gets.length).toBe(crash === 'before-receipt' ? 0 : 1)
				if (gets.length)
					expect(gets[0]).toContain(
						`/sequences/${manifest().messages[0]!.sequenceId}/`,
					)
				if (crash !== 'after-ack') expect(await row()).toEqual(before)
				else {
					// Valid historical evidence still permits real attempt/domain writes
					// through guarded getConnection transactions, not a read-only facade.
					expect((await row()).status).toBe('Accepted')
					expect(
						second.queries.some((q) =>
							/update `AI_EvergreenOfferJourneyAttempt`/i.test(q),
						),
					).toBe(true)
					expect(
						second.queries.some((q) =>
							/insert into `AI_EvergreenOfferJourneyCommit`/i.test(q),
						),
					).toBe(true)
					expect(second.queries.some((q) => q.toLowerCase() === 'commit')).toBe(
						true,
					)
				}
				expect(await second.store.event(mappingIdentity(before).id)).toEqual(
					receiptBefore,
				)
				expect(
					second.queries.filter((q) =>
						/\b(insert|update|delete)\b[\s\S]*AI_ContactEvent/i.test(q),
					),
				).toHaveLength(0)
			},
		)
		it('historical accepted/expired proof remains readable while writer refuses it', async () => {
			expect(await Effect.runPromise(front().execute(target()))).toMatchObject({
				type: 'Applied',
			})
			const attempt = await row()
			now = new Date(attempt.leaseExpiresAt.getTime() + 1000).toISOString()
			expect(await record(attempt)).toMatchObject({
				type: 'Held',
				detail: 'ClaimNotLive',
			})
			expect(
				await Effect.runPromise(map(second.store).reader.read(attempt)),
			).toMatchObject({ claimToken: attempt.claimToken })
		})
		it('replacement bundle holds saved sequence; restored original recovers without writing receipt', async () => {
			failOutcome = true
			await Effect.runPromise(Effect.either(front().execute(target())))
			failOutcome = false
			expect(posts).toBe(1)
			const before = await row()
			now = new Date(before.leaseExpiresAt.getTime() + 1000).toISOString()
			const savedBefore = await second.store.event(mappingIdentity(before).id)
			const savedCore = readMappingEventRow(savedBefore, {
				sourceEventId: 'mapping-source',
				providerIdentityId: 'identity-mapping-source',
			})
			expect(savedCore.sequenceId).toBe(manifest().messages[0]!.sequenceId)
			expect(
				await Effect.runPromise(map(second.store).reader.read(before)),
			).toMatchObject({
				sequenceId: savedCore.sequenceId,
				claimToken: before.claimToken,
			})
			const changed = structuredClone(manifest())
			changed.messages[0]!.sequenceId += 99
			const held = await Effect.runPromise(
				front({
					connection: second,
					writer: false,
					selected: changed,
				}).reconcileHeld({ limit: 20 }),
			)
			// Existing recovery folds missing, invalid and mismatching evidence into
			// one hold reason. Do not invent a new production result for this test.
			expect(JSON.stringify(held)).toContain('OriginalMappingUnavailable')
			expect(gets).toHaveLength(0)
			expect(await row()).toEqual(before)
			const recovered = await Effect.runPromise(
				front({ connection: second, writer: false }).reconcileHeld({
					limit: 20,
				}),
			)
			expect(JSON.stringify(recovered)).toContain('ReconciledAccepted')
			expect(gets).toHaveLength(1)
			expect(gets[0]).toContain(`/sequences/${savedCore.sequenceId}/`)
			expect(posts).toBe(1)
			expect((await row()).status).toBe('Accepted')
			expect(await second.store.event(mappingIdentity(before).id)).toEqual(
				savedBefore,
			)
		})
		it.each(['missing', 'foreign', 'conflicting'] as const)(
			'real recorded-outcome candidate %s holds on read-only connection',
			async (fault) => {
				const attempt = await claim()
				expect((await record(attempt)).type).toBe('Verified')
				await Effect.runPromise(
					first.attempts.settle({
						...target(),
						claimToken: attempt.claimToken,
						now: new Date(now),
						outcome: {
							type: 'Accepted',
							providerReceiptId: 'synthetic',
							appliedAt: now,
						},
					}),
				)
				const key = mappingIdentity(attempt).id
				if (fault === 'missing')
					await first.database
						.delete(contactEvent)
						.where(eq(contactEvent.id, key))
				else
					await first.database
						.update(contactEvent)
						.set(
							fault === 'foreign'
								? { contactId: 'other' }
								: { providerEventId: 'wrong' },
						)
						.where(eq(contactEvent.id, key))
				const before = await row()
				const result = await Effect.runPromise(
					front({ connection: second, writer: false }).settleRecordedOutcomes({
						limit: 20,
					}),
				)
				expect(JSON.stringify(result)).toContain('OriginalMappingUnavailable')
				expect(await row()).toEqual(before)
				expect(posts).toBe(0)
				expect(gets).toHaveLength(0)
				expect(
					second.queries.filter((q) =>
						/\b(insert|update|delete)\b[\s\S]*AI_ContactEvent/i.test(q),
					),
				).toHaveLength(0)
			},
		)
		it.each(['lease', 'window', 'control', 'canonical'] as const)(
			'receipt I/O crossing %s prevents POST',
			async (boundary) => {
				const real = first.store
				const mapping = map({
					...real,
					insert: async (saved) => {
						await real.insert(saved)
						if (boundary === 'lease')
							now = new Date(Date.parse(now) + 300001).toISOString()
						if (boundary === 'window') now = intent.notAfter
						if (boundary === 'control')
							base = {
								...base,
								automationControl: {
									type: 'Stopped',
									version: 'receipt-stop',
									reason: 'test',
								},
							}
						if (boundary === 'canonical')
							await first.database
								.update(journeySchema.evergreenOfferJourneyIntent)
								.set({
									intent: {
										...intent,
										contentResourceId: 'corrupted-after-receipt',
									},
								})
								.where(
									eq(
										journeySchema.evergreenOfferJourneyIntent.idempotencyKey,
										intent.idempotencyKey,
									),
								)
					},
				})
				const result = await Effect.runPromise(
					front({ mapping }).execute(target()),
				)
				expect(posts).toBe(0)
				expect(result).toMatchObject({
					type: 'Abandoned',
					sideEffects: 'mapping-persisted',
				})
				const attempt = await row()
				expect(attempt.status).toBe('Claimed')
				expect(attempt.outcome).toBeNull()
				expect(
					await second.store.event(mappingIdentity(attempt).id),
				).not.toBeNull()
			},
		)
		it.each(['foreign', 'conflicting'] as const)(
			'real uncertain %s candidate holds without repair',
			async (fault) => {
				const attempt = await claim()
				expect((await record(attempt)).type).toBe('Verified')
				const key = mappingIdentity(attempt).id
				await first.database
					.update(contactEvent)
					.set(
						fault === 'foreign'
							? { contactId: 'other' }
							: { providerEventId: 'wrong' },
					)
					.where(eq(contactEvent.id, key))
				const before = await row()
				now = new Date(before.leaseExpiresAt.getTime() + 1000).toISOString()
				const result = await Effect.runPromise(
					front({ connection: second, writer: false }).reconcileHeld({
						limit: 20,
					}),
				)
				expect(JSON.stringify(result)).toContain('OriginalMappingUnavailable')
				expect(await row()).toEqual(before)
				expect(posts).toBe(0)
				expect(gets).toHaveLength(0)
				expect(
					second.queries.filter((q) =>
						/\b(insert|update|delete)\b[\s\S]*AI_ContactEvent/i.test(q),
					),
				).toHaveLength(0)
			},
		)
		it.each([
			"INSERT INTO AI_ContactEvent (id) VALUES ('bad')",
			"UPDATE AI_ContactEvent SET id='bad'",
			'DELETE FROM AI_ContactEvent',
		])(
			'transactional recovery guard rejects attempted %s',
			async (statement) => {
				const start = second.queries.length
				await expect(
					second.database.transaction(async (transaction) => {
						await transaction.execute(sqlBuilder.raw(statement))
					}),
				).rejects.toThrow('Recovery ContactEvent mutation denied')
				const attempted = second.queries.slice(start)
				expect(
					attempted.filter((q) =>
						/\b(insert|update|delete)\b[\s\S]*AI_ContactEvent/i.test(q),
					),
				).toEqual([statement])
				expect(
					attempted.filter((q) => q.toLowerCase() === 'begin'),
				).toHaveLength(1)
				expect(
					attempted.filter((q) => q.toLowerCase() === 'rollback'),
				).toHaveLength(1)
				expect(
					attempted.filter((q) => q.toLowerCase() === 'commit'),
				).toHaveLength(0)
				// Sequential reacquisition must release correctly, preserve tuple-plus-
				// PlanetScale result shape, and never accumulate instrumented wrappers.
				for (let i = 0; i < 3; i++) {
					const before = second.queries.length
					const result = await second.database.transaction((transaction) =>
						transaction.execute(sqlBuilder`SELECT 1 AS value`),
					)
					expect(result).toMatchObject({
						rows: [{ value: 1 }],
						rowsAffected: 0,
					})
					expect(result[0]).toEqual([{ value: 1 }])
					expect(
						second.queries.slice(before).map((q) => q.toLowerCase()),
					).toEqual(['begin', 'select 1 as value', 'commit'])
				}
			},
		)
		it('read-only recovery connection really rejects ContactEvent INSERT UPDATE DELETE', async () => {
			for (const sql of [
				"INSERT INTO AI_ContactEvent (id) VALUES ('bad')",
				"UPDATE AI_ContactEvent SET id='bad'",
				'DELETE FROM AI_ContactEvent',
			]) {
				await expect(
					Promise.resolve().then(() =>
						second.database.execute(sqlBuilder.raw(sql)),
					),
				).rejects.toThrow('Recovery ContactEvent mutation denied')
			}
			expect(
				second.queries.filter((q) =>
					/\b(insert|update|delete)\b[\s\S]*AI_ContactEvent/i.test(q),
				),
			).toHaveLength(3)
		})
	},
)
