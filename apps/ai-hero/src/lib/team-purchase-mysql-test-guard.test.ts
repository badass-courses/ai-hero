import { describe, expect, it, vi } from 'vitest'

import {
	connectToDisposableMySqlServer,
	createDisposableDatabaseName,
	validateMySqlIntegrationServerUrl,
} from './team-purchase-mysql-test-guard'

const safeUrl = 'mysql://root:test@127.0.0.1:33067/mysql'
const safeEnvironment = { nodeEnv: 'test', vercelEnv: undefined }

describe('team purchase MySQL integration guard', () => {
	it.each([
		['remote host', 'mysql://root:test@db.example.com:33067/mysql'],
		['default MySQL port', 'mysql://root:test@127.0.0.1:3306/mysql'],
		['application user', 'mysql://app:test@127.0.0.1:33067/mysql'],
		['production database path', 'mysql://root:test@127.0.0.1:33067/ai_hero'],
	])('rejects a production-like %s', async (_name, url) => {
		const connect = vi.fn()

		await expect(
			connectToDisposableMySqlServer(url, safeEnvironment, connect),
		).rejects.toThrow('unsafe-team-fulfillment-mysql-test-url')
		expect(connect).not.toHaveBeenCalled()
	})

	it.each([
		{ nodeEnv: 'production', vercelEnv: undefined },
		{ nodeEnv: 'test', vercelEnv: 'production' },
	])('refuses a production runtime before connecting', async (environment) => {
		const connect = vi.fn()

		await expect(
			connectToDisposableMySqlServer(safeUrl, environment, connect),
		).rejects.toThrow('unsafe-team-fulfillment-mysql-test-environment')
		expect(connect).not.toHaveBeenCalled()
	})

	it('accepts only a loopback nonstandard-port server URL without an application database', () => {
		const url = validateMySqlIntegrationServerUrl(
			safeUrl,
			safeEnvironment,
		)

		expect(url.hostname).toBe('127.0.0.1')
		expect(url.port).toBe('33067')
		expect(url.pathname).toBe('/mysql')
	})

	it('creates a unique test-only database name', () => {
		const first = createDisposableDatabaseName()
		const second = createDisposableDatabaseName()

		expect(first).toMatch(/^aih_team_fulfillment_test_[a-f0-9]{32}$/)
		expect(second).toMatch(/^aih_team_fulfillment_test_[a-f0-9]{32}$/)
		expect(first).not.toBe(second)
	})
})
