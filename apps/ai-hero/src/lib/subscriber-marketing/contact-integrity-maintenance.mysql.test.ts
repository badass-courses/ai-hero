import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { contactEmailWriteValues } from './contact-email-equivalence'
import { CONTACT_EMAIL_STALE_SQL } from './contact-email-key-contract'
import { integrityExpressionAst } from './contact-maintenance-schema'
import {
	maintainContactIntegrity,
	publicMaintenanceResult,
	type MaintenanceOptions,
} from './contact-integrity-maintenance'
const url = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const suite = describe.skipIf(!url)
suite('Contact integrity maintenance native disposable CI', () => {
	let server: Pool, pool: Pool, other: Pool, name: string
	const commands: string[] = []
	const defaults: MaintenanceOptions = {
		mode: 'verify',
		pageSize: 2,
		maxRows: 100,
		maxWrites: 100,
		maxMs: 10000,
	}
	async function run(
		options: Partial<MaintenanceOptions> = {},
		hooks: {
			before?: (sql: string, values: unknown[]) => Promise<void>
			after?: (sql: string, result: unknown) => Promise<unknown>
			monotonic?: () => number
			runtime?: { node: string; unicode: string }
		} = {},
	) {
		const connection = await pool.getConnection()
		return Effect.runPromise(
			maintainContactIntegrity(
				{
					query: async (sql, values, timeout) => {
						commands.push(sql)
						await hooks.before?.(sql, values)
						const [result] = await connection.query({ sql, values, timeout })
						return hooks.after ? hooks.after(sql, result) : result
					},
					destroy: () => connection.destroy(),
				},
				{ ...defaults, ...options },
				{ monotonic: hooks.monotonic, runtime: hooks.runtime },
			),
		)
	}
	async function insert(id: string, email: string | null, projected = false) {
		const p = contactEmailWriteValues(email)
		await pool.query(
			'INSERT INTO AI_Contact(id,email,emailKey,emailKeySource,note) VALUES(?,?,?,?,?)',
			[
				id,
				email,
				projected ? p.emailKey : null,
				projected ? p.emailKeySource : null,
				'preserve',
			],
		)
	}
	beforeAll(async () => {
		if (!url || process.env.CI !== 'true') throw new Error('Disposable CI only')
		const safe = validateMySqlIntegrationServerUrl(url, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_contact_maintenance_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = mysql.createPool({
			uri: target.toString(),
			timezone: 'Z',
			connectionLimit: 5,
		})
		other = mysql.createPool({ uri: target.toString(), timezone: 'Z' })
		await pool.query(
			'CREATE TABLE AI_Contact(id varchar(255) PRIMARY KEY,email varchar(255) NULL,note varchar(255)) ENGINE=InnoDB',
		)
		await pool.query(
			await fs.readFile(
				new URL(
					'../../db/migrations/plans/20260908_contact_email_equivalence.sql',
					import.meta.url,
				),
				'utf8',
			),
		)
	})
	beforeEach(async () => {
		await pool.query('DELETE FROM AI_Contact')
		commands.length = 0
	})
	afterAll(async () => {
		await pool?.end()
		await other?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})
	it('compares actual generated expression structurally and verifies required native metadata', async () => {
		const [rows] = await pool.query<RowDataPacket[]>(
			"SELECT GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='emailKeyStale'",
		)
		expect(integrityExpressionAst(rows[0]!.GENERATION_EXPRESSION)).toEqual(
			integrityExpressionAst(CONTACT_EMAIL_STALE_SQL),
		)
		const r = await run({ mode: 'inspect' })
		expect(r.code).toBe('complete')
		expect(r.schemaReady).toBe(true)
		expect(r.coverage).toBe('schema-only')
		expect(commands.some((q) => /^UPDATE|^SELECT id,email/.test(q))).toBe(false)
	})
	it('dry-run sees NULL/malformed/Unicode without any UPDATE, then CAS preserves all raw data and duplicates', async () => {
		const emails = [
			null,
			'',
			' İ@EXAMPLE.test ',
			'i\u0307@example.test',
			'Σ@EXAMPLE.test',
			'\u212A@example.test',
			'é@example.test',
			'e\u0301@example.test',
		]
		for (const [i, email] of emails.entries()) await insert(`row-${i}`, email)
		await pool.query(
			"UPDATE AI_Contact SET emailKey='v0:bad',emailKeySource='malformed' WHERE id='row-0'",
		)
		const before = (
			await pool.query('SELECT id,email,note FROM AI_Contact ORDER BY id')
		)[0]
		const dry = await run({ mode: 'dry-run' })
		expect(dry.counts.scanned).toBe(8)
		expect(dry.counts.malformed).toBe(1)
		expect(dry.unqualifiedReady).toBe(false)
		expect(commands.some((q) => q.startsWith('UPDATE'))).toBe(false)
		const apply = await run({ mode: 'apply' })
		expect(apply.code).toBe('complete')
		expect(apply.counts.verifiedAfterWrite).toBe(8)
		expect(
			(await pool.query('SELECT id,email,note FROM AI_Contact ORDER BY id'))[0],
		).toEqual(before)
		commands.length = 0
		const verified = await run()
		expect(verified.coverage).toBe('consistent-snapshot')
		expect(verified.snapshotProjectionValid).toBe(true)
		expect(verified.counts.ambiguousGroups).toBe(1)
		expect(verified.code).toBe('held')
		expect(verified.freshGlobalGuard?.stalePresent).toBe(false)
		expect(commands.some((q) => q.startsWith('UPDATE'))).toBe(false)
		const output = JSON.stringify(publicMaintenanceResult(verified))
		for (const email of emails.filter((e): e is string => Boolean(e)))
			expect(output).not.toContain(email)
		expect(output).not.toContain('row-')
		expect(output).not.toContain(contactEmailWriteValues(emails[2]).emailKey)
	})
	it.each(['changed', 'deleted', 'null-to-email'] as const)(
		'raw-byte CAS reports %s conflict without overwriting another connection',
		async (mode) => {
			await insert(
				'race',
				mode === 'null-to-email' ? null : ' Learner@example.test ',
			)
			if (mode === 'null-to-email')
				await pool.query("UPDATE AI_Contact SET emailKey='bad' WHERE id='race'")
			const fresh = contactEmailWriteValues('LEARNER@example.test')
			const r = await run(
				{ mode: 'apply' },
				{
					before: async (sql) => {
						if (!sql.startsWith('UPDATE')) return
						if (mode === 'deleted')
							await other.query("DELETE FROM AI_Contact WHERE id='race'")
						else
							await other.query(
								'UPDATE AI_Contact SET email=?,emailKey=?,emailKeySource=? WHERE id=?',
								[fresh.email, fresh.emailKey, fresh.emailKeySource, 'race'],
							)
					},
				},
			)
			expect(r.code).toBe('held')
			expect(r.counts.acknowledgedWrites).toBe(0)
			expect(r.counts.verifiedAfterWrite).toBe(0)
			expect(r.counts.conflicts + r.counts.deleted).toBe(1)
			const [rows] = await pool.query<RowDataPacket[]>(
				'SELECT email,emailKey,emailKeySource FROM AI_Contact',
			)
			expect(rows).toEqual(mode === 'deleted' ? [] : [fresh])
		},
	)
	it.each(['throw-after', 'unknown', 'partial'] as const)(
		'never reports %s write acknowledgement as success',
		async (mode) => {
			await insert('a', 'a@example.test')
			await insert('b', 'b@example.test')
			const r = await run(
				{ mode: 'apply' },
				{
					after: async (sql, result) => {
						if (!sql.startsWith('UPDATE')) return result
						if (mode === 'throw-after')
							throw new Error('sensitive-example-must-not-escape')
						return mode === 'unknown'
							? {}
							: { affectedRows: 2, warningStatus: 0 }
					},
				},
			)
			expect(r.code).toBe('write-uncertain')
			expect(r.counts.unknownWrites).toBe(1)
			expect(r.counts.verifiedAfterWrite).toBe(0)
			expect(r.privateState.after).toBeUndefined()
			expect(JSON.stringify(publicMaintenanceResult(r))).not.toContain(
				'sensitive',
			)
			expect((await run({ mode: 'apply' })).code).toBe('complete')
		},
	)
	it('resumes only bounded pages; changed earlier rows require a new whole snapshot', async () => {
		for (const id of ['a', 'b', 'c']) await insert(id, `${id}@example.test`)
		const first = await run({ mode: 'apply', maxRows: 1 })
		expect(first.code).toBe('partial')
		expect(first.privateState.after).toBe('a')
		await other.query(
			"UPDATE AI_Contact SET email='new@example.test' WHERE id='a'",
		)
		const next = await run({ mode: 'apply', after: first.privateState.after })
		expect(next.code).toBe('complete')
		expect(next.coverage).toBe('page-only')
		expect(next.snapshotProjectionValid).toBe(false)
		const verification = await run()
		expect(verification.code).toBe('held')
		expect(verification.counts.mismatching).toBe(1)
		expect((await run({ after: 'a' })).code).toBe('invalid-options')
	})
	it('row and write budgets stop with private continuation, never whole-table validity', async () => {
		for (const id of ['a', 'b', 'c']) await insert(id, `${id}@example.test`)
		const write = await run({ mode: 'apply', maxWrites: 1 })
		expect(write.counts.attemptedWrites).toBe(1)
		expect(write.code).toBe('partial')
		expect(write.privateState.after).toBe('a')
		const verify = await run({ maxRows: 1 })
		expect(verify.code).toBe('partial')
		expect(verify.coverage).toBe('partial-snapshot')
		expect(verify.snapshotProjectionValid).toBe(false)
	})
	it('time exhaustion and runtime mismatch close without unsafe success', async () => {
		let clock = 0
		const timed = await run({ maxMs: 100 }, { monotonic: () => (clock += 101) })
		expect(timed.code).toBe('budget-exhausted')
		commands.length = 0
		const runtime = await run(
			{},
			{ runtime: { node: '22.0.0', unicode: '16.0' } },
		)
		expect(runtime.code).toBe('runtime-mismatch')
		expect(commands).toEqual([])
	})
	it('snapshot excludes concurrent coherent late insert while separately reporting the fresh guard, not all rows now', async () => {
		await insert('b', 'b@example.test', true)
		await insert('c', 'c@example.test', true)
		let changed = false
		const r = await run(
			{ pageSize: 1 },
			{
				after: async (sql, result) => {
					if (!changed && sql.startsWith('SELECT id,email')) {
						changed = true
						const p = contactEmailWriteValues('b@example.test')
						await other.query(
							'INSERT INTO AI_Contact(id,email,emailKey,emailKeySource) VALUES(?,?,?,?)',
							['a', p.email, p.emailKey, p.emailKeySource],
						)
					}
					return result
				},
			},
		)
		expect(r.code).toBe('complete')
		expect(r.coverage).toBe('consistent-snapshot')
		expect(r.counts.scanned).toBe(2)
		expect(r.counts.ambiguousGroups).toBe(0)
		expect(r.snapshotProjectionValid).toBe(true)
		expect(r.freshGlobalGuard?.stalePresent).toBe(false)
		expect(r.unqualifiedReady).toBe(false)
		expect((await run()).counts.ambiguousGroups).toBe(1)
	})
	it('fresh stale guard reports a concurrent legacy mutation separately from a valid snapshot', async () => {
		await insert('a', 'a@example.test', true)
		let changed = false
		const r = await run(
			{},
			{
				after: async (sql, result) => {
					if (!changed && sql.startsWith('SELECT id,email')) {
						changed = true
						await other.query(
							"UPDATE AI_Contact SET email='changed@example.test' WHERE id='a'",
						)
					}
					return result
				},
			},
		)
		expect(r.snapshotProjectionValid).toBe(true)
		expect(r.counts.mismatching).toBe(0)
		expect(r.freshGlobalGuard?.stalePresent).toBe(true)
		expect(r.code).toBe('held')
	})
	it('refuses altered generated guard and missing/nonunique index contract', async () => {
		await pool.query(
			'ALTER TABLE AI_Contact DROP INDEX Contact_emailKeyStale_idx',
		)
		try {
			expect((await run({ mode: 'apply' })).code).toBe('schema-mismatch')
		} finally {
			await pool.query(
				'ALTER TABLE AI_Contact ADD INDEX Contact_emailKeyStale_idx(emailKeyStale)',
			)
		}
		await pool.query(
			'ALTER TABLE AI_Contact MODIFY emailKeyStale int GENERATED ALWAYS AS (0) STORED',
		)
		try {
			expect((await run()).code).toBe('schema-mismatch')
		} finally {
			await pool.query(
				`ALTER TABLE AI_Contact MODIFY emailKeyStale int GENERATED ALWAYS AS (${CONTACT_EMAIL_STALE_SQL}) STORED`,
			)
		}
	})
	it('provider metadata cannot be used as native snapshot support', async () => {
		const r = await run(
			{},
			{
				after: async (sql, result) =>
					sql.startsWith('SELECT VERSION()')
						? [
								(result as Record<string, unknown>[])[0] && {
									...(result as Record<string, unknown>[])[0],
									comment: '',
								},
							]
						: result,
			},
		)
		expect(r.code).toBe('unsupported-snapshot')
		expect(commands.some((q) => q.startsWith('START TRANSACTION'))).toBe(false)
	})
})
