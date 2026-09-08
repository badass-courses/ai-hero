import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { contactEmailWriteValues } from './contact-email-equivalence'
import { CONTACT_EMAIL_STALE_SQL } from './contact-email-key-contract'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
integration('native Contact generated integrity PLAN', () => {
	let server: Pool | undefined, pool: Pool, name: string | undefined
	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_email_integrity_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = mysql.createPool({ uri: target.toString(), timezone: 'Z' })
		await pool.query(
			'CREATE TABLE AI_Contact (id varchar(255) PRIMARY KEY, email varchar(255) NULL, INDEX Contact_email_idx(email))',
		)
		const plan = await fs.readFile(
			new URL(
				'../../db/migrations/plans/20260908_contact_email_equivalence.sql',
				import.meta.url,
			),
			'utf8',
		)
		expect(plan).toContain(CONTACT_EMAIL_STALE_SQL)
		await pool.query(plan)
	})
	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})
	beforeEach(async () => {
		await pool.query('DELETE FROM AI_Contact')
	})
	const valid = contactEmailWriteValues(' Learner@example.test ')
	const cases = [
		{ kind: 'valid', ...valid, stale: 0 },
		{ kind: 'null-clean', ...contactEmailWriteValues(null), stale: 0 },
		{
			kind: 'raw-legacy',
			...valid,
			emailKey: null,
			emailKeySource: null,
			stale: 1,
		},
		{ kind: 'missing-source', ...valid, emailKeySource: null, stale: 1 },
		{ kind: 'missing-key', ...valid, emailKey: null, stale: 1 },
		{ kind: 'raw-change', ...valid, email: 'different@example.test', stale: 1 },
		{
			kind: 'old-version',
			...valid,
			emailKey: valid.emailKey!.replace('v1:', 'v0:'),
			stale: 1,
		},
		{
			kind: 'wrong-prefix-case',
			...valid,
			emailKey: valid.emailKey!.replace('v1:', 'V1:'),
			stale: 1,
		},
		{ kind: 'short-key', ...valid, emailKey: 'v1:abc', stale: 1 },
		{
			kind: 'invalid-key-hex',
			...valid,
			emailKey: 'v1:' + 'g'.repeat(64),
			stale: 1,
		},
		{
			kind: 'uppercase-key',
			...valid,
			emailKey: 'v1:' + valid.emailKey!.slice(3).toUpperCase(),
			stale: 1,
		},
		{
			kind: 'invalid-source-hex',
			...valid,
			emailKeySource: 'z'.repeat(64),
			stale: 1,
		},
		{
			kind: 'uppercase-source',
			...valid,
			emailKeySource: valid.emailKeySource!.toUpperCase(),
			stale: 1,
		},
		{
			kind: 'wrong-source',
			...valid,
			emailKeySource: '0'.repeat(64),
			stale: 1,
		},
		{
			kind: 'null-with-key',
			...valid,
			email: null,
			emailKeySource: null,
			stale: 1,
		},
		{
			kind: 'null-with-source',
			...valid,
			email: null,
			emailKey: null,
			stale: 1,
		},
		{ kind: 'empty-raw-projected', ...contactEmailWriteValues(''), stale: 0 },
	]
	it.each(cases)('total generated flag: $kind', async (row) => {
		await pool.execute(
			'INSERT INTO AI_Contact (id,email,emailKey,emailKeySource) VALUES (?,?,?,?)',
			[row.kind, row.email, row.emailKey, row.emailKeySource],
		)
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT emailKeyStale FROM AI_Contact WHERE id=?',
			[row.kind],
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.emailKeyStale).toBe(row.stale)
		const [stale] = await pool.query<RowDataPacket[]>(
			'SELECT id FROM AI_Contact WHERE emailKeyStale=1 LIMIT 1',
		)
		expect(stale).toHaveLength(row.stale)
	})
	it('stored generated/index metadata and duplicate preservation', async () => {
		for (const id of ['a', 'b'])
			await pool.execute(
				'INSERT INTO AI_Contact (id,email,emailKey,emailKeySource) VALUES (?,?,?,?)',
				[id, valid.email, valid.emailKey, valid.emailKeySource],
			)
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT id FROM AI_Contact WHERE emailKey=?',
			[valid.emailKey],
		)
		expect(rows).toHaveLength(2)
		const [columns] = await pool.query<RowDataPacket[]>(
			'SHOW FULL COLUMNS FROM AI_Contact',
		)
		expect(
			columns.find((row) => row.Field === 'emailKeyStale')!.Extra,
		).toContain('STORED GENERATED')
		const [indexes] = await pool.query<RowDataPacket[]>(
			'SHOW INDEX FROM AI_Contact',
		)
		for (const key of ['Contact_emailKey_idx', 'Contact_emailKeyStale_idx'])
			expect(indexes.find((row) => row.Key_name === key)!.Non_unique).toBe(1)
	})
	it('raw-only UPDATE recomputes stale without any application helper', async () => {
		await pool.execute(
			'INSERT INTO AI_Contact (id,email,emailKey,emailKeySource) VALUES (?,?,?,?)',
			['a', valid.email, valid.emailKey, valid.emailKeySource],
		)
		await pool.execute('UPDATE AI_Contact SET email=? WHERE id=?', [
			'learner@example.test',
			'a',
		])
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT emailKeyStale FROM AI_Contact',
		)
		expect(rows[0]!.emailKeyStale).toBe(1)
	})
})
