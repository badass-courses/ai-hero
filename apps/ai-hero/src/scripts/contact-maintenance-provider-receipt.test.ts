import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import {
	operatorCredentialsSchema,
	supportsPinnedPlanetScaleSnapshot,
	validateProviderReceipt,
} from './contact-maintenance-provider-receipt'
import { runMaintenanceCli } from './contact-integrity-maintenance'
function fixture(mode = 'inspect') {
	const now = Date.now(),
		role = mode === 'apply' ? ('writer' as const) : ('reader' as const)
	const config = {
		purpose: 'contact-integrity-maintenance' as const,
		provider: 'planetscale' as const,
		operatorRole: role,
		target: 'pilot',
		organization: 'fixture-org',
		database: 'fixture-db',
		branch: 'main',
		host: 'aws.connect.psdb.cloud',
		port: 3306,
		user: 'generated_provider_username_92af',
		password: 'synthetic-fixture-password',
		tls: true,
	}
	const record = {
		id: 'provider-password-id',
		name: 'approved-maintenance-label',
		username: config.user,
		access_host_url: config.host,
		role: role === 'writer' ? 'readwriter' : 'reader',
		database_branch: { name: 'main' },
		created_at: new Date(now - 60000).toISOString(),
		expires_at: new Date(now + 3600000).toISOString(),
		deleted_at: '0001-01-01T00:00:00Z',
		ttl_seconds: 3600,
		replica: false,
	}
	const receipt = {
		version: 1,
		provider: 'planetscale',
		purpose: config.purpose,
		operatorRole: role,
		target: 'pilot',
		approvalRef: 'approved-packet',
		organization: config.organization,
		database: config.database,
		branch: 'main',
		credentialName: record.name,
		readbackAt: new Date(now - 1000).toISOString(),
		validUntil: new Date(now + 600000).toISOString(),
		creation: { ...record, plain_text: config.password },
		readback: { ...record },
	}
	const binding = {
		target: 'pilot',
		approvalRef: 'approved-packet',
		mode,
		maxMs: 10000,
	}
	const encode = () => {
		const raw = JSON.stringify(receipt)
		return { raw, pin: createHash('sha256').update(raw).digest('hex') }
	}
	return { config, receipt, binding, encode, now }
}
describe('PlanetScale operator receipt boundary', () => {
	it.each([
		'valid',
		'copy',
		'missing',
		'expiry',
		'database',
		'version',
		'comment',
		'mode',
	])('keeps snapshot compatibility bound to the minted receipt: %s', (kind) => {
		const f = fixture(kind === 'mode' ? 'inspect' : 'verify')
		const { raw, pin } = f.encode()
		const evidence = validateProviderReceipt(
			raw,
			pin,
			f.config,
			f.binding,
			f.now,
		)
		expect(Object.isFrozen(evidence)).toBe(true)
		expect(Object.isFrozen(evidence.scope)).toBe(true)
		const server = {
			version: '8.4.11',
			comment: '',
			databaseName: f.config.database,
		}
		if (kind === 'database') server.databaseName = 'other'
		if (kind === 'version') server.version = '8.4.12'
		if (kind === 'comment') server.comment = 'MySQL Community Server - GPL'
		expect(
			supportsPinnedPlanetScaleSnapshot(
				kind === 'copy'
					? { ...evidence }
					: kind === 'missing'
						? undefined
						: evidence,
				server,
				10000,
				kind === 'expiry' ? evidence.validUntil - 5000 : f.now,
			),
		).toBe(kind === 'valid')
	})
	it.each(['', 'a/b', 'a b', '`name`', 'a;b', 'a'.repeat(65)])(
		'refuses malformed or overlong database name %s',
		(database) => {
			expect(
				operatorCredentialsSchema.safeParse({ ...fixture().config, database })
					.success,
			).toBe(false)
		},
	)
	it.each(['inspect', 'dry-run', 'apply', 'verify'])(
		'accepts generated usernames for %s with exact pinned create/readback scope',
		(mode) => {
			const f = fixture(mode),
				{ raw, pin } = f.encode()
			expect(
				validateProviderReceipt(raw, pin, f.config, f.binding, f.now).scope,
			).toContain('provider-password-id')
		},
	)
	it.each([
		'username',
		'host',
		'role',
		'branch',
		'id',
		'password',
		'purpose',
		'organization',
		'database',
		'target',
		'approval',
		'expiry',
		'deleted',
		'replica',
		'pin',
		'operator-role',
		'readback-time',
	])('holds %s mismatch', (kind) => {
		const f = fixture()
		if (kind === 'username')
			f.receipt.readback.username = 'another-generated-user'
		if (kind === 'host') f.receipt.readback.access_host_url = 'other.psdb.cloud'
		if (kind === 'role') f.receipt.readback.role = 'admin'
		if (kind === 'branch')
			f.receipt.readback.database_branch = { name: 'other' }
		if (kind === 'id') f.receipt.readback.id = 'other-password'
		if (kind === 'password') f.receipt.creation.plain_text = 'wrong'
		if (kind === 'purpose')
			f.receipt.purpose = 'app' as typeof f.receipt.purpose
		if (kind === 'organization') f.config.organization = 'other'
		if (kind === 'database') f.config.database = 'other'
		if (kind === 'target') f.binding.target = 'other'
		if (kind === 'approval') f.binding.approvalRef = 'other'
		if (kind === 'expiry')
			f.receipt.readback.expires_at = new Date(f.now - 1).toISOString()
		if (kind === 'deleted')
			f.receipt.readback.deleted_at = new Date(f.now - 1).toISOString()
		if (kind === 'replica') f.receipt.readback.replica = true
		if (kind === 'operator-role') f.config.operatorRole = 'writer'
		if (kind === 'readback-time')
			f.receipt.readbackAt = new Date(f.now + 1000).toISOString()
		const { raw, pin } = f.encode()
		expect(() =>
			validateProviderReceipt(
				raw,
				kind === 'pin' ? '0'.repeat(64) : pin,
				f.config,
				f.binding,
				f.now,
			),
		).toThrow()
	})
	it('requires local approved expiry even for a provider password without TTL', () => {
		const f = fixture()
		for (const p of [f.receipt.creation, f.receipt.readback]) {
			p.ttl_seconds = 0
			p.expires_at = '0001-01-01T00:00:00Z'
		}
		let e = f.encode()
		expect(
			validateProviderReceipt(e.raw, e.pin, f.config, f.binding, f.now)
				.validUntil,
		).toBe(Date.parse(f.receipt.validUntil))
		f.receipt.validUntil = new Date(f.now).toISOString()
		e = f.encode()
		expect(() =>
			validateProviderReceipt(e.raw, e.pin, f.config, f.binding, f.now),
		).toThrow()
	})
	it('uses the pinned provider path without guessing proxy CURRENT_USER semantics and keeps output redacted', async () => {
		const f = fixture(),
			{ raw, pin } = f.encode(),
			query = vi.fn(
				async (_sql: string, _values: unknown[], _timeout: number) => [],
			),
			destroy = vi.fn(),
			connect = vi.fn(async () => ({ query, destroy }))
		const result = await runMaintenanceCli(
			[
				'--mode',
				'inspect',
				'--target',
				'pilot',
				'--approval-ref',
				'approved-packet',
				'--acknowledge-approval',
				'--credential-fd',
				'3',
				'--provider-receipt-fd',
				'4',
				'--provider-receipt-sha256',
				pin,
			],
			{
				connect,
				readCredential: (fd) => (fd === 3 ? JSON.stringify(f.config) : raw),
			},
		)
		expect(connect).toHaveBeenCalledTimes(1)
		expect(
			query.mock.calls.some((c) => String(c[0]).includes('CURRENT_USER')),
		).toBe(false)
		expect(destroy).toHaveBeenCalledTimes(1)
		// Mock metadata is deliberately absent, not a database compatibility claim.
		expect(result.exitCode).toBe(2)
		for (const value of [f.config.user, f.config.password, f.config.host, pin])
			expect(JSON.stringify(result.output)).not.toContain(value)
	})
	it('refuses a bare provider username with no separately pinned receipt before connecting', async () => {
		const f = fixture(),
			connect = vi.fn(async () => {
				throw new Error('forbidden')
			})
		const result = await runMaintenanceCli(
			[
				'--mode',
				'inspect',
				'--target',
				'pilot',
				'--approval-ref',
				'approved-packet',
				'--acknowledge-approval',
				'--credential-fd',
				'3',
			],
			{ connect, readCredential: () => JSON.stringify(f.config) },
		)
		expect(result.exitCode).toBe(2)
		expect(connect).not.toHaveBeenCalled()
	})
})
