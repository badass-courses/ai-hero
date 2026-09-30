import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'

import { contactEmailWriteValues } from './contact-email-equivalence'
import {
	reconcileSkillsConfirmations,
	ReconcilerEvidenceUnavailableError,
	SKILLS_CONFIRMATION_RECONCILIATION_LIMIT,
	SKILLS_CONFIRMATION_RECONCILIATION_START,
	SKILLS_NEWSLETTER_FORM_ID,
	type SkillsConfirmationEvent,
} from './signup-confirmation-reconciler.server'

// The real reconciler query against disposable MySQL: which confirmed Kit
// subscribers count as already entered, and which get replayed.
const TO = '2026-09-26T00:00:00.000Z'
const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

type KitRow = {
	id: string
	email: string
	addedAt: string
	fields?: Record<string, string>
}
type KitPage = (url: URL) => Response | undefined

integration('skills confirmation reconciler on disposable MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let database: MySqlDatabase<any, any, any>
	let kitActive: KitRow[]
	let kitTagged: Map<string, string[]>
	let kitSequences: Map<string, string[]>
	let kitOverride: KitPage | undefined

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_confirm_reconciler_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = preserveQueryResultShape(
			mysql.createPool({
				uri: target.toString(),
				timezone: 'Z',
				multipleStatements: true,
			}),
		)
		for (const migration of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			// The canonical email key (prod has it; the plan is its DDL).
			'plans/20260908_contact_email_equivalence.sql',
		])
			await pool.query(
				await fs.readFile(
					new URL(`../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		database = drizzle(pool, { mode: 'planetscale' })
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		for (const table of [
			'AI_SideEffectIntent',
			'AI_ContactEvent',
			'AI_ProviderIdentity',
			'AI_Contact',
		])
			await pool.query(`DELETE FROM ${table}`)
		kitActive = []
		kitTagged = new Map()
		kitSequences = new Map()
		kitOverride = undefined
		vi.stubEnv('CONVERTKIT_V4_API_KEY', 'test-kit-key')
		vi.stubGlobal('fetch', async (input: URL | string) => {
			const url = new URL(String(input))
			const overridden = kitOverride?.(url)
			if (overridden) return overridden
			// One subscriber's tags (row 211 reads them per candidate).
			const tagsOf = /\/v4\/subscribers\/(\d+)\/tags$/.exec(url.pathname)?.[1]
			if (tagsOf)
				return Response.json({
					tags: [...kitTagged]
						.filter(([, ids]) => ids.includes(tagsOf))
						.map(([id]) => ({ id: Number(id), name: id, tagged_at: TO })),
					pagination: { has_next_page: false, end_cursor: null },
				})
			const tag = /\/v4\/tags\/(\d+)\/subscribers$/.exec(url.pathname)?.[1]
			const sequence = /\/v4\/sequences\/(\d+)\/subscribers$/.exec(
				url.pathname,
			)?.[1]
			const rows = tag
				? kitActive.filter((row) => kitTagged.get(tag)?.includes(row.id))
				: sequence
					? kitActive.filter((row) =>
							kitSequences.get(sequence)?.includes(row.id),
						)
					: url.searchParams.get('status') === 'active'
						? kitActive
						: []
			const subscribers = rows.map((row) => ({
				id: Number(row.id),
				email_address: row.email,
				state: 'active',
				created_at: row.addedAt,
				added_at: row.addedAt,
				fields: row.fields ?? {},
			}))
			return Response.json({
				subscribers,
				pagination: { has_next_page: false, end_cursor: null },
			})
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	let addedMinute = 0
	function confirmed(id: string): KitRow {
		addedMinute += 1
		const row = {
			id,
			email: `learner-${id}@example.test`,
			addedAt: new Date(
				Date.parse(SKILLS_CONFIRMATION_RECONCILIATION_START) +
					addedMinute * 60_000,
			).toISOString(),
		}
		kitActive.push(row)
		return row
	}

	async function captured(row: KitRow) {
		const contactId = `contact-${row.id}`
		await contactRow(contactId, row.email)
		await pool.query(
			"INSERT INTO AI_ProviderIdentity (id, contactId, provider, externalId, evidence) VALUES (?, ?, 'kit', ?, '{}')",
			[`identity-${row.id}`, contactId, row.id],
		)
		await event(
			row,
			'skills-newsletter.subscribed',
			`skills-form:${SKILLS_NEWSLETTER_FORM_ID}:subscriber:${row.id}`,
		)
		return contactId
	}

	async function contactRow(id: string, email: string) {
		const values = contactEmailWriteValues(email)
		await pool.query(
			'INSERT INTO AI_Contact (id, email, emailKey, emailKeySource) VALUES (?, ?, ?, ?)',
			[id, values.email, values.emailKey, values.emailKeySource],
		)
	}

	async function intent(contactId: string, type: string) {
		await pool.query(
			"INSERT INTO AI_SideEffectIntent (id, nextActionId, contactId, provider, type, status, idempotencyKey, gates, reviewReasons, metadata) VALUES (?, ?, ?, 'kit', ?, 'planned', ?, '{}', '[]', '{}')",
			[randomUUID(), randomUUID(), contactId, type, randomUUID()],
		)
	}

	/** A contact Kit knows under another subscriber id, stored as typed. */
	async function addressOnlyContact(id: string, storedEmail: string) {
		await contactRow(id, storedEmail)
		await pool.query(
			"INSERT INTO AI_ProviderIdentity (id, contactId, provider, externalId, evidence) VALUES (?, ?, 'kit', ?, '{}')",
			[`identity-${id}`, id, `other-kit-${id}`],
		)
	}

	async function event(
		row: KitRow,
		eventType: string,
		providerEventId: string,
		providerReference = `kit:${providerEventId}`,
	) {
		await pool.query(
			"INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt) VALUES (?, ?, ?, 'kit', ?, ?, ?, ?, 'internal', '{}', '{}', 1, ?)",
			[
				randomUUID(),
				`contact-${row.id}`,
				`identity-${row.id}`,
				providerEventId,
				providerReference,
				eventType,
				`kit:${eventType}:${row.id}:${providerEventId}`,
				new Date(row.addedAt),
			],
		)
	}

	async function drovrOwned(
		row: KitRow,
		journeyId = 'value-path-skills-course',
	) {
		const contactId = await captured(row)
		await event(
			row,
			'journey.owner.assigned',
			`drovr-owner:${contactId}:${journeyId}`,
		)
	}

	async function legacyEntered(row: KitRow) {
		await captured(row)
		await event(
			row,
			'value-path.entered',
			`value-path-entry:${row.id}`,
			'value-path:ai-hero-skills-workflow',
		)
	}

	const plannedIds = (plan: {
		events: Array<{ data: { kitSubscriberId: string } }>
	}) => plan.events.map((event) => event.data.kitSubscriberId)

	/** One daily-tier run, sent events collected, Kit's pacing not waited. */
	async function reconcile(args: {
		to: string
		limit?: number
		database: Parameters<typeof reconcileSkillsConfirmations>[0]['database']
	}) {
		const events: SkillsConfirmationEvent[] = []
		const receipt = await reconcileSkillsConfirmations({
			...args,
			tier: 'daily',
			kit: { sleep: async () => {}, minStartIntervalMs: 0 },
			steps: {
				run: (_, work) => work(),
				send: async (_, event) => {
					events.push(event)
				},
			},
		})
		return { ...receipt, events }
	}

	it('skips drovr-owned contacts, so a confirmation at the back of the list is replayed', async () => {
		// The first Kit page is full of contacts drovr already owns; the
		// newest confirmations sit behind them.
		for (const id of ['1001', '1002', '1003']) await drovrOwned(confirmed(id))
		await legacyEntered(confirmed('1004'))
		// Owned only for the shadow newsletter: not entered in the skills course.
		await drovrOwned(confirmed('1005'), 'shadow-newsletter')
		await captured(confirmed('1006'))
		confirmed('1007')

		const plan = await reconcile({
			to: TO,
			limit: 3,
			database,
		})

		expect(plannedIds(plan)).toEqual(['1007', '1006', '1005'])
		expect(plan.counts).toMatchObject({
			candidates: 3,
			planned: 3,
			deferred: 0,
		})
	})

	it('never replays a signup from before the floor, only those after it', async () => {
		// Joel's call (2026-09-25): the stranded backlog is let go. A
		// confirmed, unentered subscriber who joined the form before the
		// floor is never planned; one who joined after it is.
		const beforeFloor = confirmed('9001')
		beforeFloor.addedAt = new Date(
			Date.parse(SKILLS_CONFIRMATION_RECONCILIATION_START) - 60_000,
		).toISOString()
		await captured(confirmed('9002'))
		const capturedBeforeFloor = kitActive.at(-1)!
		capturedBeforeFloor.addedAt = '2026-09-24T12:00:00.000Z'
		confirmed('9003')

		const plan = await reconcile({
			to: TO,
			database,
		})

		expect(plannedIds(plan)).toEqual(['9003'])
		expect(plan.window.from).toBe('2026-09-25T00:00:00.000Z')
	})

	it('matches the ownership event to the same contact, not any contact', async () => {
		const owner = confirmed('2001')
		await drovrOwned(owner)
		const other = confirmed('2002')
		await captured(other)
		// An assignment recorded against contact 2002 but naming contact 2001
		// is not 2002's own birth.
		await event(
			other,
			'journey.owner.assigned',
			'drovr-owner:contact-2001:value-path-skills-course',
		)

		const plan = await reconcile({
			to: TO,
			database,
		})

		expect(plannedIds(plan)).toEqual(['2002'])
	})

	it('never enters an active subscriber who opted out of AI Hero or the skills emails', async () => {
		// Kit `active` is not consent: the AI Hero and AI Skills unsubscribe
		// tags, and local unsubscribe/bounce/complaint evidence, all exclude.
		const aiHeroTagged = confirmed('4001')
		const skillsTagged = confirmed('4002')
		const unsubscribed = confirmed('4003')
		await captured(unsubscribed)
		await event(unsubscribed, 'contact.unsubscribed', 'kit-unsub:4003')
		const bounced = confirmed('4004')
		await captured(bounced)
		await event(bounced, 'contact.bounced', 'kit-bounce:4004')
		await captured(confirmed('4005'))
		await intent('contact-4005', 'unsubscribe-kit-list')
		// Complained on a contact Kit knows under another id, its address
		// stored with different case and whitespace.
		const byEmail = confirmed('4006')
		await addressOnlyContact(
			'contact-email-only',
			` ${byEmail.email.toUpperCase()} `,
		)
		await pool.query(
			"INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt) VALUES ('ev-email-only', 'contact-email-only', 'identity-contact-email-only', 'kit', 'unsub-email-only', 'kit:unsub-email-only', 'contact.complained', 'k-email-only', 'internal', '{}', '{}', 1, NOW())",
		)
		// A list unsubscribe still pending (no event yet), same kind of address.
		const pending = confirmed('4008')
		await addressOnlyContact(
			'contact-pending-unsub',
			`\t${pending.email.replace('learner', 'Learner')}  `,
		)
		await intent('contact-pending-unsub', 'unsubscribe-kit-list')
		kitTagged.set('8244351', [aiHeroTagged.id])
		kitTagged.set('19251081', [skillsTagged.id])
		confirmed('4007')

		const plan = await reconcile({
			to: TO,
			database,
		})

		expect(plannedIds(plan)).toEqual(['4007'])
		// The two tagged ones are excluded at the scan, by the tags read in
		// their creation-day slices (row 211).
		expect(plan.counts).toMatchObject({
			candidates: 1,
			excludedByTag: 2,
			excludedOptedOut: 7,
			planned: 1,
		})
	})

	it('applies the shared stop rule: a later fresh double opt-in lifts an unsubscribe, never a bounce', async () => {
		const at = (row: KitRow, minutes: number) =>
			new Date(Date.parse(row.addedAt) + minutes * 60_000)
		const stamp = (
			row: KitRow,
			eventType: string,
			providerEventId: string,
			minutes: number,
		) =>
			pool.query(
				"INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt) VALUES (?, ?, ?, 'kit', ?, ?, ?, ?, 'internal', '{}', '{}', 1, ?)",
				[
					randomUUID(),
					`contact-${row.id}`,
					`identity-${row.id}`,
					providerEventId,
					`kit:${providerEventId}`,
					eventType,
					`kit:${eventType}:${row.id}:${providerEventId}`,
					at(row, minutes),
				],
			)
		// Lifted: an unsubscribe event, then a confirmation.
		const lifted = confirmed('4101')
		await captured(lifted)
		await stamp(lifted, 'contact.unsubscribed', 'u-4101', 1)
		await stamp(lifted, 'contact.resubscribed', 'r-4101', 2)
		// Lifted: a drovr list unsubscribe row, then a confirmation.
		const liftedList = confirmed('4102')
		await captured(liftedList)
		await pool.query(
			"INSERT INTO AI_SideEffectIntent (id, nextActionId, contactId, provider, type, status, idempotencyKey, gates, reviewReasons, metadata, createdAt) VALUES (?, ?, 'contact-4102', 'kit', 'unsubscribe-kit-list', 'completed', ?, '{}', '[]', '{}', ?)",
			[randomUUID(), randomUUID(), randomUUID(), at(liftedList, 1)],
		)
		await stamp(liftedList, 'contact.resubscribed', 'r-4102', 2)
		// Unsubscribed again after the lift.
		const again = confirmed('4103')
		await captured(again)
		await stamp(again, 'contact.unsubscribed', 'u-4103', 1)
		await stamp(again, 'contact.resubscribed', 'r-4103', 2)
		await stamp(again, 'contact.unsubscribed', 'u2-4103', 3)
		// A bounce never lifts.
		const bounced = confirmed('4104')
		await captured(bounced)
		await stamp(bounced, 'contact.bounced', 'b-4104', 1)
		await stamp(bounced, 'contact.resubscribed', 'r-4104', 2)

		const plan = await reconcile({
			to: TO,
			database,
		})

		expect([...plannedIds(plan)].sort()).toEqual(['4101', '4102'])
		expect(plan.counts).toMatchObject({ excludedOptedOut: 2 })
	})

	it('never restarts the course for someone who already got course email', async () => {
		// In email 0's Kit sequence (individual or team path).
		kitSequences.set('2757199', [confirmed('6001').id])
		kitSequences.set('2757206', [confirmed('6002').id])
		// Finished the course, per the Kit field.
		confirmed('6003').fields = { aih_course_completed_at: '2026-09-01' }
		// A value-path send on record, under its own Kit id or by address.
		const sent = confirmed('6004')
		await captured(sent)
		await intent('contact-6004', 'send-value-path-email')
		const sentByAddress = confirmed('6005')
		await addressOnlyContact(
			'contact-sent-other-id',
			` ${sentByAddress.email.toUpperCase()}`,
		)
		await intent('contact-sent-other-id', 'send-value-path-email')
		confirmed('6006')

		const plan = await reconcile({
			to: TO,
			database,
		})

		expect(plannedIds(plan)).toEqual(['6006'])
		expect(plan.counts).toMatchObject({
			candidates: 1,
			excludedCourseHistory: 5,
		})
	})

	it('fails the run when a Contact email key is stale', async () => {
		confirmed('7001')
		await pool.query(
			"INSERT INTO AI_Contact (id, email) VALUES ('contact-stale', 'stale@example.test')",
		)

		await expect(
			reconcile({
				to: TO,
				database,
			}),
		).rejects.toThrow(ReconcilerEvidenceUnavailableError)
	})

	it.each([
		[
			'an HTTP failure',
			() => Response.json({ error: 'nope' }, { status: 403 }),
		],
		[
			'a 200 without a subscriber list',
			() => Response.json({ pagination: { has_next_page: false } }),
		],
		[
			'a malformed subscriber id',
			() =>
				Response.json({
					subscribers: [{ id: 'abc' }],
					pagination: { has_next_page: false, end_cursor: null },
				}),
		],
		[
			'a next page without a cursor',
			() =>
				Response.json({
					subscribers: [{ id: 1 }],
					pagination: { has_next_page: true, end_cursor: null },
				}),
		],
		['a body that is not JSON', () => new Response('<html>', { status: 200 })],
	])('fails closed on %s from a consent or history list', async (_, page) => {
		confirmed('8001')
		// Email 0's list failing fails the run: nobody is sent.
		kitOverride = (url) =>
			url.pathname === '/v4/sequences/2757199/subscribers' ? page() : undefined
		await expect(reconcile({ to: TO, database })).rejects.toThrow(
			ReconcilerEvidenceUnavailableError,
		)
		// The subscriber's own tags failing skips that subscriber, unsent, and
		// the run goes on (Sonnet 2, #348 S2).
		kitOverride = (url) =>
			url.pathname === '/v4/subscribers/8001/tags' ? page() : undefined
		const plan = await reconcile({ to: TO, database })
		expect(plannedIds(plan)).toEqual([])
		expect(plan.counts).toMatchObject({ tagFailed: 1, planned: 0 })
	})

	it('stops or slows on AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT, never above 50', async () => {
		for (let index = 0; index < 60; index++) confirmed(String(5000 + index))
		const planned = async (limit: string) => {
			vi.stubEnv('AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT', limit)
			const plan = await reconcile({
				to: TO,
				database,
			})
			return [plan.counts.planned, plan.limit]
		}

		expect(await planned('0')).toEqual([0, 0])
		expect(await planned('10')).toEqual([10, 10])
		expect(await planned('500')).toEqual([50, 50])
		expect(await planned('nope')).toEqual([50, 50])
	})

	it('plans at most 50 per hourly run by default', async () => {
		expect(SKILLS_CONFIRMATION_RECONCILIATION_LIMIT).toBe(50)
		for (let index = 0; index < 55; index++) confirmed(String(3000 + index))

		const plan = await reconcile({
			to: TO,
			database,
		})

		expect(plan.counts).toMatchObject({
			candidates: 55,
			planned: 50,
			deferred: 5,
		})
	})
})
