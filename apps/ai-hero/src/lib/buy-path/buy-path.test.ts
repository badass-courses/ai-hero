import { describe, expect, it, vi, afterEach } from 'vitest'
import { buyPathSchema, clientBuyPathSchema } from './schema'
import { createBuyPathLogger } from './client'
import {
	checkPurchaseInvariants,
	purchaseInvariantChecks,
	type PurchaseSnapshot,
} from './invariants'
import { ingestBuyPath } from './ingest'
import { readBuyPathToken, signBuyPathToken } from './token'

const base = {
	telemetrySchemaVersion: 1,
	occurredAt: '2026-01-01T00:00:00.000Z',
	buyPathId: 'cs_test_fixture',
	purchaseId: null,
	productId: 'product_fixture',
	userId: null,
	step: 'checkout_created',
	outcome: 'ok',
	durationMs: 0,
	sincePaymentMs: null,
	source: 'server',
}
const client = {
	buyPathId: 'cs_test_fixture',
	step: 'client_returned',
	outcome: 'ok',
	durationMs: 0,
}
afterEach(() => {
	vi.unstubAllGlobals()
})
describe('buy path contract', () => {
	it('accepts the versioned contract and rejects missing ids, PII, and invalid clocks', () => {
		expect(buyPathSchema.safeParse(base).success).toBe(true)
		for (const change of [
			{ buyPathId: undefined },
			{ email: 'synthetic@example.test' },
			{ userId: 'synthetic@example.test' },
			{ durationMs: -1 },
			{ sincePaymentMs: -1 },
			{ step: 'arbitrary' },
		])
			expect(buyPathSchema.safeParse({ ...base, ...change }).success).toBe(
				false,
			)
		expect(
			clientBuyPathSchema.safeParse({ ...client, userId: 'forged_user' })
				.success,
		).toBe(false)
	})
	it('caps client polls and survives a broken transport', () => {
		const transport = vi.fn()
		const emit = createBuyPathLogger('cs_test_fixture', transport)
		for (let i = 0; i < 60; i++)
			emit('client_polling', { attempt: Math.min(i, 45) })
		expect(transport).toHaveBeenCalledTimes(46)
		expect(() =>
			createBuyPathLogger('cs_test_fixture', () => {
				throw Error()
			})('client_returned'),
		).not.toThrow()
	})
	it('uses beacon for unload and keepalive if beacon refuses', () => {
		const beacon = vi.fn(() => true)
		const fetcher = vi.fn(() => Promise.resolve(new Response()))
		vi.stubGlobal('navigator', { sendBeacon: beacon })
		vi.stubGlobal('fetch', fetcher)
		createBuyPathLogger('cs_test_fixture')('client_returned')
		expect(beacon).toHaveBeenCalledOnce()
		expect(fetcher).not.toHaveBeenCalled()
		beacon.mockReturnValue(false)
		createBuyPathLogger('cs_test_fixture')('destination_rendered')
		expect(fetcher).toHaveBeenCalledWith(
			'/api/telemetry/buy-path',
			expect.objectContaining({ keepalive: true }),
		)
	})
})
const good: PurchaseSnapshot = {
	buyPathId: 'cs_test_fixture',
	purchaseId: 'purchase_fixture',
	productId: 'product_fixture',
	userId: 'user_fixture',
	exists: true,
	status: 'Valid',
	entitlementCount: 1,
	expectedEntitlementCount: 1,
	totalCents: 12345,
	chargeCents: 12345,
	requiresCharge: true,
}
describe('readback invariants', () => {
	it.each([
		['purchase', { exists: false }],
		['status', { status: 'Refunded' }],
		['entitlements', { entitlementCount: 0 }],
		['charge', { chargeCents: null }],
		['amount', { chargeCents: 12344 }],
	] as const)('emits a field failure for %s', async (field, delta) => {
		const emit = vi.fn(async () => {})
		const result = await checkPurchaseInvariants(
			{ ...good, ...delta },
			purchaseInvariantChecks,
			emit,
		)
		expect(result).toContain(field)
		expect(emit).toHaveBeenCalledWith(field)
	})
	it('supports the desk decision hook and fails closed when a check throws', async () => {
		const emit = vi.fn(async () => {})
		expect(
			await checkPurchaseInvariants(good, purchaseInvariantChecks, emit),
		).toEqual([])
		expect(
			await checkPurchaseInvariants(
				good,
				[{ field: 'decision', check: () => false }],
				emit,
			),
		).toEqual(['decision'])
		expect(
			await checkPurchaseInvariants(
				good,
				[
					{
						field: 'charge',
						check: () => {
							throw Error()
						},
					},
				],
				emit,
			),
		).toEqual(['charge'])
	})
})
describe('ingest route boundary', () => {
	it('uses trusted deployment origin behind a reconstructed internal URL, not spoofed Host', async () => {
		const deps = { origin: 'https://app.example', limit: vi.fn(async () => true), context: vi.fn(async () => null), emit: vi.fn() }
		const internal = (origin: string) => new Request('http://localhost:3000/api/telemetry/buy-path', { method: 'POST', headers: { origin, host: 'app.example' }, body: '{' })
		expect((await ingestBuyPath(internal('https://app.example'), deps)).status).toBe(400)
		const foreign = await ingestBuyPath(internal('https://foreign.example'), deps)
		expect(foreign.status).toBe(403)
		expect(foreign.headers.get('x-buy-path-rejection')).toBe('origin')
		expect(deps.limit).toHaveBeenCalledOnce()
	})
	const req = (body: unknown, origin = 'https://app.example') =>
		new Request('https://app.example/api/telemetry/buy-path', {
			method: 'POST',
			headers: { origin },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		})
	const context = {
		buyPathId: 'cs_test_fixture',
		purchaseId: null,
		productId: 'product_fixture',
		userId: null,
	}
	it('validates body, origin, authority, and rate limit before emitting', async () => {
		const deps = {
			limit: vi.fn(async () => true),
			context: vi.fn(async () => context),
			emit: vi.fn(async () => {}),
		}
		expect((await ingestBuyPath(req(client), deps)).status).toBe(204)
		expect(
			(
				await ingestBuyPath(
					req({ ...client, email: 'synthetic@example.test' }),
					deps,
				)
			).status,
		).toBe(400)
		expect((await ingestBuyPath(req('not json'), deps)).status).toBe(400)
		expect((await ingestBuyPath(req('x'.repeat(2049)), deps)).status).toBe(413)
		expect(
			(await ingestBuyPath(req(client, 'https://foreign.example'), deps))
				.status,
		).toBe(403)
		deps.limit.mockResolvedValue(false)
		expect((await ingestBuyPath(req(client), deps)).status).toBe(429)
		expect(deps.emit).toHaveBeenCalledOnce()
		expect(
			(
				await ingestBuyPath(req(client), {
					...deps,
					limit: async () => true,
					context: async () => null,
				})
			).status,
		).toBe(403)
	})
	it('refuses forged and expired checkout capabilities', () => {
		const value = {
			buyPathId: 'cs_test_fixture',
			productId: 'product_fixture',
			userId: null,
			preSessionId: null,
			expiresAt: Date.now() + 10000,
		}
		const token = signBuyPathToken(value, 'test-only-secret')
		expect(readBuyPathToken(token, 'test-only-secret')).toEqual(value)
		expect(readBuyPathToken(token, 'other-test-secret')).toBeNull()
		expect(readBuyPathToken(token + 'x', 'test-only-secret')).toBeNull()
		expect(
			readBuyPathToken(
				signBuyPathToken({ ...value, expiresAt: 0 }, 'test-only-secret'),
				'test-only-secret',
			),
		).toBeNull()
	})
})
