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
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'

const mysqlServerUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!mysqlServerUrl)
const schema = {
	contact,
	contactEvent,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
}

integration('exit-held intents by type MySQL contract', () => {
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
		databaseName = `aih_exit_held_test_${randomUUID().replaceAll('-', '')}`
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
			'../../db/migrations/20260717_ai_hero_side_effect_intent_completed_at.sql',
		]) {
			await pool.query(
				await fs.readFile(new URL(migrationPath, import.meta.url), 'utf8'),
			)
		}
		repository = new DrizzleCaptureMarketingRepository(
			drizzle(pool, { schema, mode: 'planetscale' }),
		)
	})

	beforeEach(async () => {
		await pool.query('TRUNCATE TABLE `AI_SideEffectIntent`')
	})

	afterAll(async () => {
		await pool?.end()
		if (serverPool && databaseName)
			await serverPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
		await serverPool?.end()
	})

	const insert = (
		id: string,
		overrides: {
			status?: string
			type?: string
			list?: string
			createdAt?: string
		} = {},
	) =>
		pool.query(
			`INSERT INTO AI_SideEffectIntent
			(id, nextActionId, contactId, provider, type, status, idempotencyKey, gates, reviewReasons, metadata, createdAt)
			VALUES (?, ?, ?, 'kit', ?, ?, ?, '[]', '[]', ?, ?)`,
			[
				id,
				`action-${id}`,
				`contact-${id}`,
				overrides.type ?? 'subscribe-evergreen-list',
				overrides.status ?? 'held-for-exit',
				`key-${id}`,
				JSON.stringify({ list: overrides.list ?? 'shadow-newsletter' }),
				new Date(overrides.createdAt ?? '2026-10-01T00:00:00.000Z'),
			],
		)

	it('filters by type, status and list in SQL and pages by (createdAt, id)', async () => {
		await insert('a')
		await insert('b')
		await insert('c', { createdAt: '2026-10-01T00:00:05.000Z' })
		await insert('d', { createdAt: '2026-10-01T00:00:09.000Z' })
		await insert('x-status', { status: 'pending' })
		await insert('x-type', { type: 'send-shadow-newsletter-email' })
		await insert('x-list', { list: 'other' })
		const base = {
			type: 'subscribe-evergreen-list' as const,
			list: 'shadow-newsletter',
			limit: 2,
		}
		const first = await repository.findExitHeldSideEffectIntentsByType(base)
		expect(first.map((row: { id: string }) => row.id)).toEqual(['a', 'b'])
		const second = await repository.findExitHeldSideEffectIntentsByType({
			...base,
			after: {
				createdAt: first[1]!.createdAt,
				id: first[1]!.id,
			},
		})
		expect(second.map((row: { id: string }) => row.id)).toEqual(['c', 'd'])
		const third = await repository.findExitHeldSideEffectIntentsByType({
			...base,
			after: { createdAt: second[1]!.createdAt, id: second[1]!.id },
		})
		expect(third).toEqual([])
	})
})
