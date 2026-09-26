import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { createDrizzleContactProfileVersionStore } from './contact-profile-version-drizzle'
import { createDrizzleValuePathLinkAnchorStore } from './drizzle-value-path-link-anchor'
import {
	resolveValuePathLinkAnchor,
	type ValuePathLinkAnchorStore,
} from './value-path-link-anchor'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

const key = {
	contactId: 'contact-mysql-anchor',
	valuePathSlug: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-0',
	fingerprint: 'f'.repeat(64),
}
const first = {
	issuedAt: '2026-09-26T16:00:00.123Z',
	expiresAt: '2027-01-24T16:00:00.123Z',
}

integration('contact-sync stores on MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let store: ValuePathLinkAnchorStore
	let versions: ReturnType<typeof createDrizzleContactProfileVersionStore>

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_link_anchor_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = mysql.createPool({
			uri: target.toString(),
			timezone: 'Z',
			multipleStatements: true,
		})
		const acquire = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(await acquire())) as typeof pool.getConnection
		const migration = await fs.readFile(
			new URL(
				'../../db/migrations/20260926_ai_hero_contact_sync.sql',
				import.meta.url,
			),
			'utf8',
		)
		await pool.query(migration)
		// Rerunnable: the second apply skips all three tables.
		await pool.query(migration)
		const database = drizzle(pool, { schema: databaseSchema, mode: 'default' })
		store = createDrizzleValuePathLinkAnchorStore(database)
		versions = createDrizzleContactProfileVersionStore(database)
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		await pool.query('DELETE FROM AI_ValuePathLinkAnchor')
		await pool.query('DELETE FROM AI_ContactProfileVersion')
	})

	it('creates the three contact-sync tables and nothing else', async () => {
		const [rows] = await pool.query(
			'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
		)
		expect((rows as { name: string }[]).map((row) => row.name)).toEqual([
			'AI_ContactProfileVersion',
			'AI_ContactSyncCursor',
			'AI_ValuePathLinkAnchor',
		])
	})

	it('stores a first issue in UTC and answers exists for a second insert', async () => {
		await expect(store.insert(key, first)).resolves.toBe('inserted')
		await expect(
			store.insert(key, {
				issuedAt: '2026-09-27T00:00:00.000Z',
				expiresAt: '2027-01-25T00:00:00.000Z',
			}),
		).resolves.toBe('exists')
		await expect(store.find(key)).resolves.toEqual(first)
		await expect(
			store.find({ ...key, fingerprint: 'e'.repeat(64) }),
		).resolves.toBeUndefined()
	})

	it('answers later windows from the first issue without rewriting the row', async () => {
		await expect(
			resolveValuePathLinkAnchor({ store, key, now: first.issuedAt }),
		).resolves.toEqual(first)
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2027-01-10T16:00:00.000Z',
			}),
		).resolves.toEqual({
			issuedAt: '2026-12-25T16:00:00.123Z',
			expiresAt: '2027-04-24T16:00:00.123Z',
		})
		await expect(store.find(key)).resolves.toEqual(first)
	})

	it('converges concurrent first issues on one row', async () => {
		const answers = await Promise.all(
			['2026-09-26T16:00:00.000Z', '2026-09-26T16:00:01.000Z'].map((now) =>
				resolveValuePathLinkAnchor({ store, key, now }),
			),
		)
		expect(answers[0]).toBeDefined()
		expect(answers[1]).toEqual(answers[0])
		const [rows] = await pool.query(
			'SELECT COUNT(*) AS n FROM AI_ValuePathLinkAnchor',
		)
		expect((rows as { n: number }[])[0]?.n).toBe(1)
	})

	it('counts a contact profile version up from 1 and never hands out one twice', async () => {
		await expect(versions.bump('contact-v')).resolves.toBe(1)
		await expect(versions.bump('contact-v')).resolves.toBe(2)
		await expect(versions.bump('contact-w')).resolves.toBe(1)
		const concurrent = await Promise.all(
			Array.from({ length: 6 }, () => versions.bump('contact-v')),
		)
		expect([...concurrent].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8])
		const [rows] = await pool.query(
			"SELECT profileVersion AS v FROM AI_ContactProfileVersion WHERE contactId = 'contact-v'",
		)
		expect(Number((rows as { v: number }[])[0]?.v)).toBe(8)
	})
})
