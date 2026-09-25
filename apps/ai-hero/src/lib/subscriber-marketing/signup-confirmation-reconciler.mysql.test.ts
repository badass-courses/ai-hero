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

import {
	buildSignupConfirmationReconciliationBatch,
	SKILLS_CONFIRMATION_RECONCILIATION_LIMIT,
	SKILLS_NEWSLETTER_FORM_ID,
} from './signup-confirmation-reconciler.server'

// The real reconciler query against disposable MySQL: which confirmed Kit
// subscribers count as already entered, and which get replayed.
const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

type KitRow = { id: string; email: string; addedAt: string }

integration('skills confirmation reconciler on disposable MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let database: MySqlDatabase<any, any, any>
	let kitActive: KitRow[]

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
		await pool.query(
			await fs.readFile(
				new URL(
					'../../db/migrations/20260504_ai_hero_subscriber_marketing_gate_a.sql',
					import.meta.url,
				),
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
			'AI_ContactEvent',
			'AI_ProviderIdentity',
			'AI_Contact',
		])
			await pool.query(`DELETE FROM ${table}`)
		kitActive = []
		vi.stubEnv('CONVERTKIT_V4_API_KEY', 'test-kit-key')
		vi.stubGlobal('fetch', async (input: URL | string) => {
			const url = new URL(String(input))
			const subscribers =
				url.searchParams.get('status') === 'active'
					? kitActive.map((row) => ({
							id: Number(row.id),
							email_address: row.email,
							state: 'active',
							created_at: row.addedAt,
							added_at: row.addedAt,
						}))
					: []
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
				Date.parse('2026-09-20T00:00:00Z') + addedMinute * 60_000,
			).toISOString(),
		}
		kitActive.push(row)
		return row
	}

	async function captured(row: KitRow) {
		const contactId = `contact-${row.id}`
		await pool.query('INSERT INTO AI_Contact (id, email) VALUES (?, ?)', [
			contactId,
			row.email,
		])
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

	it('skips drovr-owned contacts, so a confirmation at the back of the list is replayed', async () => {
		// The first Kit page is full of contacts drovr already owns; the
		// newest confirmations sit behind them.
		for (const id of ['1001', '1002', '1003']) await drovrOwned(confirmed(id))
		await legacyEntered(confirmed('1004'))
		// Owned only for the shadow newsletter: not entered in the skills course.
		await drovrOwned(confirmed('1005'), 'shadow-newsletter')
		await captured(confirmed('1006'))
		confirmed('1007')

		const plan = await buildSignupConfirmationReconciliationBatch({
			to: '2026-09-25T00:00:00.000Z',
			limit: 3,
			database,
		})

		expect(plannedIds(plan)).toEqual(['1007', '1006', '1005'])
		expect(plan.counts).toMatchObject({
			replayable: 3,
			planned: 3,
			deferred: 0,
		})
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

		const plan = await buildSignupConfirmationReconciliationBatch({
			to: '2026-09-25T00:00:00.000Z',
			database,
		})

		expect(plannedIds(plan)).toEqual(['2002'])
	})

	it('plans at most 50 per hourly run by default', async () => {
		expect(SKILLS_CONFIRMATION_RECONCILIATION_LIMIT).toBe(50)
		for (let index = 0; index < 55; index++) confirmed(String(3000 + index))

		const plan = await buildSignupConfirmationReconciliationBatch({
			to: '2026-09-25T00:00:00.000Z',
			database,
		})

		expect(plan.counts).toMatchObject({
			replayable: 55,
			planned: 50,
			deferred: 5,
		})
	})
})
