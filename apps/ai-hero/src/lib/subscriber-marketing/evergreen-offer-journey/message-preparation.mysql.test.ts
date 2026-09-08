import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import mysql, { type Pool } from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { Effect } from 'effect'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import * as schema from '@/db/evergreen-offer-journey-schema'
import {
	contact,
	providerIdentity,
	contactEvent,
	prices,
	coupon,
} from '@/db/schema'
import { commerceDdl } from './coupon-executor-commerce.fixtures'
import {
	calendarFlow,
	calendarCommit,
	calendarStimulusId,
} from './calendar-version.fixtures'
import {
	decodeIssue,
	semanticCouponId,
	readCouponEvidence,
} from './coupon-authority'
import { compileMessageTemplate } from './message-preparation'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { contactEmailWriteValues } from '../contact-email-equivalence'
import { preparationFixture } from './message-preparation.fixtures'
import { sourceFixture } from './bounded-readers.fixtures'
import {
	createMySqlMessagePreparationStore,
	preparationEventRow,
} from './message-preparation-store'
import { createMessageFieldsTransport } from './message-preparation-fields'
import { createTrustedMessagePreparation } from './message-preparation-source'
import { createMessagePreparationGate } from './message-preparation-gate'
import { preparationNamespace } from './message-preparation'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import {
	createOriginalDeliveryMapping,
	createMySqlOriginalMappingPersistence,
} from './original-delivery-mapping-mysql'
import { createRevisionDelivery } from './revision-delivery'
import { createEvergreenOfferJourneyService } from './service'
import { EVERGREEN_OFFER_JOURNEY_V3 } from './definition'
import type { IsoInstant } from './primitives'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
integration('native immutable preparation; synthetic Kit only', () => {
	let server: Pool,
		admin: Pool,
		writer: Pool,
		reader: Pool,
		name: string,
		db: ReturnType<typeof connect>,
		read: ReturnType<typeof connect>
	let f: ReturnType<typeof preparationFixture>,
		now: string,
		puts: number,
		posts: number,
		mode: string,
		profile: {
			id: number
			email_address: string
			state: string
			fields: Record<string, string | null>
		}
	function connect(pool: Pool) {
		return drizzle(preserveQueryResultShape(pool), {
			schema,
			mode: 'planetscale',
		})
	}
	const store = () =>
		createMySqlMessagePreparationStore({
			database: db,
			readback: read,
			now: () => now,
		})
	const http: typeof fetch = async (_url, init) => {
		const url = String(_url)
		if (init?.method === 'POST') {
			posts++
			if (mode === 'enrollment-uncertain')
				throw new Error('Synthetic lost enrollment response')
			return new Response(
				JSON.stringify({ subscriber: { id: 123, state: 'active' } }),
				{ status: 201 },
			)
		}
		if (url.includes('/v4/'))
			return new Response(
				JSON.stringify({
					subscriber: {
						id: 123,
						email_address:
							mode === 'late-provider-identity'
								? 'changed@example.test'
								: f.snapshot.email,
						state: 'active',
					},
				}),
				{ status: 200 },
			)
		if (init?.method === 'PUT') {
			puts++
			const body = JSON.parse(String(init.body))
			expect(Object.keys(body).sort()).toEqual(['api_secret', 'fields'])
			if (mode !== 'partial') Object.assign(profile.fields, body.fields)
			if (mode === 'identity-change')
				profile.email_address = 'changed@example.test'
			if (mode === 'expiry-change') now = f.intent.notAfter
			if (mode === 'control-change') mode = 'stopped'
			if (mode === 'uncertain')
				throw new Error('Synthetic lost field response after update')
		}
		return new Response(JSON.stringify({ subscriber: profile }), {
			status: 200,
		})
	}
	const fields = () =>
		createMessageFieldsTransport({
			apiSecret: 'synthetic-not-a-credential',
			fetch: http,
		})
	beforeAll(async () => {
		const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_prep_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
		)
		const uri = new URL(safe)
		uri.pathname = `/${name}`
		admin = mysql.createPool({
			uri: uri.toString(),
			timezone: 'Z',
			multipleStatements: true,
		})
		for (const file of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260714_ai_hero_optin_attribution.sql',
			'20260717_ai_hero_side_effect_intent_completed_at.sql',
			'plans/20260908_contact_email_equivalence.sql',
			'20260831_ai_hero_email_course_evergreen_schema.sql',
			'20260907_evergreen_admission_attempts.sql',
		])
			await admin.query(
				await fs.readFile(
					new URL(`../../../db/migrations/${file}`, import.meta.url),
					'utf8',
				),
			)
		await admin.query(
			commerceDdl.find((s) => s.startsWith('CREATE TABLE AI_Coupon '))!,
		)
		await admin.query(
			'CREATE TABLE AI_Price (id varchar(191) PRIMARY KEY, productId varchar(191), organizationId varchar(191), nickname varchar(191), status int NOT NULL DEFAULT 0, unitAmount decimal(10,2) NOT NULL, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), fields json)',
		)
		writer = mysql.createPool({
			uri: uri.toString(),
			timezone: 'Z',
			connectionLimit: 2,
		})
		reader = mysql.createPool({
			uri: uri.toString(),
			timezone: 'Z',
			connectionLimit: 2,
		})
		db = connect(writer)
		read = connect(reader)
	})
	beforeEach(async () => {
		for (const table of [
			'AI_EvergreenOfferJourneyAttempt',
			'AI_EvergreenOfferJourneyWake',
			'AI_EvergreenOfferJourneyIntent',
			'AI_EvergreenOfferJourneyCommit',
			'AI_ContactEvent',
			'AI_ProviderIdentity',
			'AI_Contact',
			'AI_Coupon',
			'AI_Price',
		])
			await admin.query(`DELETE FROM \`${table}\``)
		f = preparationFixture()
		now = f.now
		puts = 0
		posts = 0
		mode = 'normal'
		profile = {
			id: 123,
			email_address: f.snapshot.email,
			state: 'active',
			fields: {
				unrelated: 'preserve',
				...Object.fromEntries(
					Object.keys(f.snapshot.fields).map((k) => [k, null]),
				),
			},
		}
		await db.insert(contact).values({
			id: f.intent.contactId,
			...contactEmailWriteValues(f.snapshot.email),
		})
		await db.insert(providerIdentity).values({
			id: f.snapshot.providerIdentityId,
			contactId: f.intent.contactId,
			provider: 'kit',
			externalId: '123',
			evidence: { source: 'synthetic' },
		})
		const source = sourceFixture('preparation-fixture')
		await db
			.insert(providerIdentity)
			.values({
				id: source.providerIdentityId,
				contactId: source.contactId,
				provider: 'ai-hero',
				externalId: 'synthetic-source',
				evidence: { source: 'synthetic' },
			})
		await db.insert(contactEvent).values(source)
		const ledger = createDrizzleJourneyLedger(db)
		await Effect.runPromise(ledger.commit(f.entry))
		await Effect.runPromise(ledger.commit(f.wake))
	})
	afterAll(async () => {
		await writer?.end()
		await reader?.end()
		await admin?.end()
		if (name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})
	it('persists/replays exact snapshot through independent handle', async () => {
		const s = store()
		expect(await s.freeze(f.snapshot)).toEqual(f.snapshot)
		expect(
			await s.freeze({
				...f.snapshot,
				preparedAt: new Date(Date.parse(now) + 1).toISOString(),
			}),
		).toEqual(f.snapshot)
		expect(await s.find(f.intent.idempotencyKey)).toEqual(f.snapshot)
		expect(await s.read(f.snapshot, 'namespace')).toBe(true)
		expect(
			(await db.select().from(contactEvent)).filter(
				(r) => r.eventType === 'evergreen.message_preparation.v1',
			),
		).toHaveLength(2)
	})
	it('conflicting values and subscriber changes cannot replace one intent', async () => {
		const s = store()
		await s.freeze(f.snapshot)
		expect(
			await s.freeze({
				...f.snapshot,
				fields: {
					...f.snapshot.fields,
					[Object.keys(f.snapshot.fields)[0]!]: 'changed',
				},
			}),
		).toBeNull()
		expect(await s.freeze({ ...f.snapshot, subscriberId: 456 })).toBeNull()
		expect(await s.find(f.snapshot.intentKey)).toEqual(f.snapshot)
	})
	it('namespace anchor blocks another journey/contact from overwriting same subscriber slot', async () => {
		const s = store()
		await s.freeze(f.snapshot)
		expect(
			await s.freeze({
				...f.snapshot,
				intentKey: 'other-intent',
				journeyId: 'other-journey',
				contactId: 'other-contact',
			}),
		).toBeNull()
	})
	it('two concurrent claimers get one acknowledged field request permission', async () => {
		const s = store()
		await s.freeze(f.snapshot)
		const outcomes = await Promise.all([
			s.claim(f.snapshot, 'fields-requested'),
			store().claim(f.snapshot, 'fields-requested'),
		])
		expect(outcomes.filter((x) => x === 'Claimed')).toHaveLength(1)
		expect(outcomes.filter((x) => x === 'Exists')).toHaveLength(1)
	})
	it('lost INSERT acknowledgments require readback and never grant request ownership', async () => {
		const lossy = new Proxy(db, {
			get(target, key) {
				if (key !== 'insert') return Reflect.get(target, key)
				return (table: typeof contactEvent) => ({
					values: async (values: typeof contactEvent.$inferInsert) => {
						await target.insert(table).values(values)
						throw new Error('Synthetic ACK loss after native commit')
					},
				})
			},
		})
		const s = createMySqlMessagePreparationStore({
			database: lossy,
			readback: read,
			now: () => now,
		})
		expect(await s.freeze(f.snapshot)).toEqual(f.snapshot)
		expect(await s.claim(f.snapshot, 'fields-requested')).toBe('Exists')
		expect(await store().read(f.snapshot, 'fields-requested')).toBe(true)
		expect(puts).toBe(0)
		expect(posts).toBe(0)
	})
	it('two slots cannot cross-overwrite, including a delayed old projection', async () => {
		const s = store(),
			namespace = preparationNamespace(f.snapshot.revision, 'B2'),
			second = {
				...f.snapshot,
				slot: 'B2' as const,
				namespace,
				intentKey: 'synthetic-b2',
				fields: { [`${namespace}_first_name`]: 'Second' },
			}
		expect(await s.freeze(f.snapshot)).not.toBeNull()
		expect(await s.freeze(second)).not.toBeNull()
		Object.assign(
			profile.fields,
			Object.fromEntries(Object.keys(second.fields).map((k) => [k, null])),
		)
		const arrived = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>()
		const delayed = createMessageFieldsTransport({
			apiSecret: 'synthetic',
			fetch: async (url, init) => {
				if (init?.method === 'PUT') {
					arrived.resolve()
					await release.promise
				}
				return http(url, init)
			},
		})
		const old = delayed.project(f.snapshot)
		await arrived.promise
		await fields().project(second)
		release.resolve()
		await old
		expect(await fields().confirm(second)).toBe(true)
		expect(profile.fields.unrelated).toBe('preserve')
	})
	it('unknown field response reconciles only by GET; no duplicate PUT', async () => {
		const s = store()
		mode = 'uncertain'
		const gate = createMessagePreparationGate({
			store: s,
			fields: fields(),
			build: async () => f.snapshot,
			current: async () => true,
		})
		const evidence = {
			claimToken: f.snapshot.claimToken,
			claimedAt: new Date(f.snapshot.claimedAt),
		} as Parameters<typeof gate.prepare>[1]
		expect((await gate.prepare(f.intent, evidence)).type).toBe('Ready')
		expect((await gate.prepare(f.intent, evidence)).type).toBe('Ready')
		expect(puts).toBe(1)
		expect(posts).toBe(0)
	})
	it('partial projection/crash remains held; membership is not consulted without enrollment marker', async () => {
		const s = store()
		mode = 'partial'
		const gate = createMessagePreparationGate({
			store: s,
			fields: fields(),
			build: async () => f.snapshot,
			current: async () => true,
		})
		const evidence = {
			claimToken: f.snapshot.claimToken,
			claimedAt: new Date(f.snapshot.claimedAt),
		} as Parameters<typeof gate.prepare>[1]
		expect((await gate.prepare(f.intent, evidence)).type).toBe('Held')
		mode = 'normal'
		expect((await gate.prepare(f.intent, evidence)).type).toBe('Held')
		expect(puts).toBe(1)
		expect(await gate.mayReconcile(f.intent)).toBe(false)
		expect(posts).toBe(0)
	})
	it('enrollment reservation cannot be replayed or fabricated after crash', async () => {
		const s = store()
		await s.freeze(f.snapshot)
		const gate = createMessagePreparationGate({
			store: s,
			fields: fields(),
			build: async () => f.snapshot,
			current: async () => true,
		})
		expect(await gate.reserveEnrollment(f.snapshot)).toBe(false)
		const ready = await gate.prepare(f.intent, {
			claimToken: f.snapshot.claimToken,
			claimedAt: new Date(f.snapshot.claimedAt),
		} as Parameters<typeof gate.prepare>[1])
		if (ready.type !== 'Ready')
			throw new Error('Expected confirmed preparation')
		expect(await gate.reserveEnrollment(ready.snapshot)).toBe(true)
		expect(await gate.reserveEnrollment(ready.snapshot)).toBe(false)
		expect(await gate.mayReconcile(f.intent)).toBe(true)
		expect(puts).toBe(1)
		expect(posts).toBe(0)
	})
	it.each(['valid', 'missing-price', 'changed-coupon'])(
		'native public-price and issued-coupon source: %s; no User/checkout source',
		async (kind) => {
			const flow = calendarFlow(
					EVERGREEN_OFFER_JOURNEY_V3,
					'preparation-fixture',
				),
				issue = decodeIssue(flow.intent)
			const row = {
				id: semanticCouponId(issue.idempotencyKey),
				organizationId: null,
				code: null,
				createdAt: new Date(issue.issueAt),
				expires: new Date(issue.expiresAt),
				fields: {
					exclusive: true,
					evergreenOffer: {
						format: 1,
						issue,
						operationObservedAt: issue.issueAt,
						binding: { type: 'AwaitingVerifiedUser' },
					},
				},
				maxUses: 1,
				default: false,
				merchantCouponId: 'synthetic-merchant',
				status: 1,
				usedCount: 0,
				percentageDiscount: null,
				amountDiscount: 10000,
				restrictedToProductId: issue.terms.productId,
			}
			await db
				.insert(coupon)
				.values({
					...row,
					amountDiscount: kind === 'changed-coupon' ? 9999 : 10000,
				})
			if (kind !== 'missing-price')
				await db
					.insert(prices)
					.values({
						id: 'synthetic-public-price',
						productId: issue.terms.productId,
						unitAmount: '349.00',
						status: 1,
					})
			const pitch = calendarCommit(
				flow.pending.decision.next,
				{ ...flow.issued, coupon: readCouponEvidence(row).coupon },
				issue.issueAt,
				EVERGREEN_OFFER_JOURNEY_V3,
			)
			const w = pitch.decision.wakeIntents.find(
				(w) => w.purpose.type === 'MessageSlot',
			)!
			const wake = calendarCommit(
				pitch.decision.next,
				{
					type: 'WakeDue',
					stimulusId: calendarStimulusId('price-source-wake'),
					journeyId: w.journeyId,
					wakeId: w.wakeId,
					purpose: w.purpose,
					dueAt: w.dueAt,
				},
				w.dueAt,
				EVERGREEN_OFFER_JOURNEY_V3,
			)
			const intent = wake.decision.sideEffectIntents.find(
				(i) => i.type === 'SendMessage',
			)!
			if (intent.type !== 'SendMessage') throw new Error('Missing pitch intent')
			now = wake.decidedAt
			const keys = compileMessageTemplate(
				f.templates.find((t) => t.slot === intent.slotId)!,
				{
					FIRST_NAME: 'there',
					REGULAR_PRICE: 'x',
					DISCOUNT_AMOUNT: 'x',
					DEADLINE_DISPLAY: 'x',
				},
			).fields
			Object.assign(
				profile.fields,
				Object.fromEntries(Object.keys(keys).map((k) => [k, null])),
			)
			const ledger = {
				...createDrizzleJourneyLedger(db),
				load: () => Effect.succeed(wake.decision.next),
			}
			const gate = createTrustedMessagePreparation({
				database: db,
				ledger,
				templates: f.templates,
				store: store(),
				fields: fields(),
				now: () => now,
			})
			const result = await gate.prepare(intent, {
				claimToken: f.snapshot.claimToken,
				claimedAt: new Date(now),
			} as Parameters<typeof gate.prepare>[1])
			if (kind === 'valid') {
				expect(result, JSON.stringify(result)).toMatchObject({ type: 'Ready' })
				if (result.type !== 'Ready') throw new Error('Expected ready')
				expect(Object.values(result.snapshot.fields)).toContain('$349')
				expect(Object.values(result.snapshot.fields)).toContain('$100')
				expect(result.snapshot.authority.timeZone).toBe('America/Los_Angeles')
				expect(result.snapshot.authority.expiresAt).toBe(issue.expiresAt)
			} else {
				expect(result.type).toBe('Held')
				expect(puts).toBe(0)
			}
			expect(posts).toBe(0)
		},
	)
	it('malformed persisted snapshot fails closed', async () => {
		const row = preparationEventRow({
			version: 1,
			stage: 'snapshot',
			observedAt: now,
			snapshot: f.snapshot,
		})
		await db.insert(contactEvent).values({ ...row, provider: 'kit' })
		expect(await store().freeze(f.snapshot)).toBeNull()
		expect(await store().find(f.intent.idempotencyKey)).toBeNull()
	})
	async function execute() {
		const ledger = createDrizzleJourneyLedger(db),
			attempts = createDrizzleJourneyAttempts(db),
			clock = { now: Effect.sync(() => now as IsoInstant) }
		const authority = {
			currentFacts: () =>
				Effect.sync(() => ({
					...f.wake.currentFacts,
					readAt: now as IsoInstant,
					automationControl:
						mode === 'stopped'
							? {
									type: 'Stopped' as const,
									version: 'stopped',
									reason: 'synthetic stop',
								}
							: f.wake.currentFacts.automationControl,
				})),
		}
		const service = createEvergreenOfferJourneyService({
			ledger,
			clock,
			authority,
			definition: EVERGREEN_OFFER_JOURNEY_V3,
		})
		const mapping = createOriginalDeliveryMapping({
			store: createMySqlOriginalMappingPersistence(db),
			now: () => now,
		})
		const gate = createTrustedMessagePreparation({
			database: db,
			ledger,
			templates: f.templates,
			store: store(),
			fields: fields(),
			now: () => now,
		})
		const delivery = createRevisionDelivery({
			bundles: [
				{
					manifest: f.manifest,
					originalMapping: mapping.reader,
					mappingWriter: mapping.writer,
					providerReadbacks: f.manifest.messages.map((m) => ({
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
				ledger,
				attempts,
				service,
				clock,
				authority,
				preparation: gate,
			},
			kit: {
				apiKey: 'synthetic',
				fetch: http,
				resolveIdentity: async (contactId) => ({
					contactId,
					subscriberId: mode === 'late-app-identity' ? 456 : 123,
				}),
			},
			now: () => now,
		})
		return Effect.runPromise(
			delivery.execute({
				journeyId: f.intent.journeyId,
				idempotencyKey: f.intent.idempotencyKey,
			}),
		)
	}
	it('actual owned executor prepares from app profile, then enrolls once; replay does not resend', async () => {
		const result = await execute()
		expect(result, JSON.stringify(result)).toMatchObject({ type: 'Applied' })
		expect(puts).toBe(1)
		expect(posts).toBe(1)
		await execute()
		expect(posts).toBe(1)
		const frozen = await store().find(f.intent.idempotencyKey)
		expect(frozen?.revision.definitionVersion).toBe('evergreen-offer-v3')
		expect(frozen?.notAfter).toBe(f.intent.notAfter)
	})
	it('lost enrollment response stays unknown and never resends or rebuilds its snapshot', async () => {
		mode = 'enrollment-uncertain'
		expect((await execute()).type).toBe('HeldUncertain')
		const before = await store().find(f.intent.idempotencyKey)
		await execute()
		expect(posts).toBe(1)
		expect(puts).toBe(1)
		expect(await store().find(f.intent.idempotencyKey)).toEqual(before)
	})
	it.each([
		'partial',
		'identity-change',
		'expiry-change',
		'control-change',
		'late-provider-identity',
		'late-app-identity',
	])('actual executor refuses enrollment after %s', async (value) => {
		mode = value
		const result = await execute()
		expect(result.type).not.toBe('Applied')
		expect(posts).toBe(0)
		expect(puts).toBe(1)
	})
})
