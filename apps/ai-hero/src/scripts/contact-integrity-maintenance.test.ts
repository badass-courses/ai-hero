import { describe, it, expect, vi } from 'vitest'
import {
	runMaintenanceCli,
	offlineMaintenancePlan,
} from './contact-integrity-maintenance'
import { integrityExpressionAst } from '../lib/subscriber-marketing/contact-maintenance-schema'
import { CONTACT_EMAIL_STALE_SQL } from '../lib/subscriber-marketing/contact-email-key-contract'

describe('offline maintenance CLI and dedicated boundary', () => {
	it.each([[], ['--help'], ['--mode', 'plan']].map((args) => [args]))(
		'help/plan %j never read credentials or construct a database',
		async (args) => {
			const connect = vi.fn(async () => {
					throw new Error('forbidden')
				}),
				readCredential = vi.fn(() => {
					throw new Error('forbidden')
				})
			expect(
				await runMaintenanceCli(args, { connect, readCredential }),
			).toEqual({ exitCode: 0, output: offlineMaintenancePlan })
			expect(connect).not.toHaveBeenCalled()
			expect(readCredential).not.toHaveBeenCalled()
		},
	)
	it.each(
		[
			['--mode', 'inspect'],
			['--mode', 'apply', '--target', 'prod', '--credential-fd', '3'],
			[
				'--mode',
				'dry-run',
				'--target',
				'prod',
				'--approval-ref',
				'packet-5',
				'--credential-fd',
				'3',
			],
			[
				'--mode',
				'verify',
				'--target',
				'prod',
				'--approval-ref',
				'packet-5',
				'--credential-fd',
				'0',
				'--acknowledge-approval',
			],
			[
				'--mode',
				'verify',
				'--target',
				'prod',
				'--approval-ref',
				'packet-5',
				'--credential-fd',
				'3',
				'--acknowledge-approval',
				'--state-in',
				'private-state.json',
			],
			['--mode', 'inspect', '--password', 'synthetic-secret'],
			['--mode', 'inspect', '--mode', 'plan'],
		].map((args) => [args]),
	)(
		'refuses missing/invalid authority shape before connection %j',
		async (args) => {
			const connect = vi.fn(async () => {
					throw new Error('forbidden')
				}),
				readCredential = vi.fn(() => {
					throw new Error('forbidden')
				})
			const result = await runMaintenanceCli(args, { connect, readCredential })
			expect(result.exitCode).toBe(2)
			expect(connect).not.toHaveBeenCalled()
			expect(readCredential).not.toHaveBeenCalled()
			expect(JSON.stringify(result.output)).not.toContain('synthetic-secret')
		},
	)
	const flags = [
		'--mode',
		'inspect',
		'--target',
		'review',
		'--approval-ref',
		'packet-5',
		'--credential-fd',
		'3',
		'--acknowledge-approval',
	]
	const credential = {
		purpose: 'contact-integrity-maintenance',
		target: 'review',
		host: 'not-a-real-host.invalid',
		port: 3306,
		database: 'fixture',
		user: 'aih_contact_maintenance_reader',
		password: 'synthetic-secret',
		tls: true,
	}
	it.each([
		{ ...credential, user: 'application-writer' },
		{ ...credential, target: 'another' },
		{ ...credential, purpose: 'app' },
		{ ...credential, tls: false },
	])(
		'rejects app credentials / mismatched target / insecure boundary',
		async (config) => {
			const connect = vi.fn(async () => {
				throw new Error('must not connect')
			})
			const r = await runMaintenanceCli(flags, {
				connect,
				readCredential: () => JSON.stringify(config),
			})
			expect(r.exitCode).toBe(2)
			expect(connect).not.toHaveBeenCalled()
			expect(JSON.stringify(r.output)).not.toContain('synthetic-secret')
		},
	)
	it('refuses an authenticated principal that differs from the dedicated requested account', async () => {
		const query = vi.fn(async () => [{ principal: 'application-user' }]),
			destroy = vi.fn()
		const r = await runMaintenanceCli(flags, {
			readCredential: () => JSON.stringify(credential),
			connect: async () => ({ query, destroy }),
		})
		expect(r.exitCode).toBe(2)
		expect(query).toHaveBeenCalledTimes(1)
		expect(destroy).toHaveBeenCalledTimes(1)
	})
	it('only reaches connector after dedicated explicit input, and redacts thrown credentials', async () => {
		const connect = vi.fn(async () => {
			throw new Error('synthetic-secret not-a-real-host.invalid')
		})
		const result = await runMaintenanceCli(flags, {
			connect,
			readCredential: () => JSON.stringify(credential),
		})
		expect(connect).toHaveBeenCalledTimes(1)
		expect(result.output).toEqual({
			version: 1,
			code: 'maintenance-refused',
			approvalGranted: false,
			unqualifiedReady: false,
		})
	})
})
describe('generated guard structural comparison', () => {
	it('accepts MySQL grouping and unary BINARY cast equivalence', () => {
		expect(
			integrityExpressionAst(
				"(BINARY LEFT(`emailKey`,3) <> BINARY _utf8mb4'v1:')",
			),
		).toEqual(
			integrityExpressionAst(
				"CAST(LEFT(emailKey,3) AS BINARY) <> CAST('v1:' AS BINARY)",
			),
		)
	})
	it('does not erase precedence or version changes', () => {
		expect(
			integrityExpressionAst(
				'email IS NULL OR emailKey IS NULL AND emailKeySource IS NULL',
			),
		).not.toEqual(
			integrityExpressionAst(
				'(email IS NULL OR emailKey IS NULL) AND emailKeySource IS NULL',
			),
		)
		expect(
			integrityExpressionAst(CONTACT_EMAIL_STALE_SQL.replace("'v1:'", "'v0:'")),
		).not.toEqual(integrityExpressionAst(CONTACT_EMAIL_STALE_SQL))
	})
	it('rejects unrecognized functions, tokens and trailing SQL', () => {
		for (const expression of [
			'LOWER(email)',
			'email IS NULL; SELECT 1',
			'email = emailKey',
			"BINARY _latin1'v1:'",
		])
			expect(() => integrityExpressionAst(expression)).toThrow()
	})
})
