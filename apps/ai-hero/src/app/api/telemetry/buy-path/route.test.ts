import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({
	limit: vi.fn(),
	getPurchase: vi.fn(),
	getProduct: vi.fn(),
	emit: vi.fn(),
	auth: vi.fn(),
}))
vi.mock('@upstash/ratelimit', () => ({
	Ratelimit: class {
		static slidingWindow() {
			return {}
		}
		limit = mocks.limit
	},
}))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@/env.mjs', () => ({
	env: { NODE_ENV: 'production', COURSEBUILDER_URL: 'https://app.example', NEXT_PUBLIC_URL: 'https://app.example', NEXTAUTH_SECRET: 'test-auth-secret' },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseByCheckoutSessionId: mocks.getPurchase,
		getProduct: mocks.getProduct,
	},
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: mocks.emit }))
vi.mock('@/lib/buy-path/read-context', () => ({
	purchaseBuyPathContext: vi.fn(),
}))
import { POST } from './route'
import { signBuyPathToken } from '@/lib/buy-path/token'
const context = {
	buyPathId: 'cs_test_fixture',
	productId: 'product_fixture',
	userId: 'user_fixture',
	preSessionId: null,
	expiresAt: Date.now() + 60000,
}
const payload = {
	buyPathId: 'cs_test_fixture',
	step: 'client_returned',
	outcome: 'ok',
	durationMs: 100,
}
const request = (
	body: unknown = payload,
	cookie = signBuyPathToken(context, 'test-auth-secret'),
) =>
	new NextRequest('https://app.example/api/telemetry/buy-path', {
		method: 'POST',
		headers: {
			origin: 'https://app.example',
			cookie: `buy_path_session=${cookie}`,
			'x-forwarded-for': '192.0.2.1',
		},
		body: JSON.stringify(body),
	})
beforeEach(() => {
	vi.clearAllMocks()
	mocks.limit.mockResolvedValue({ success: true })
	mocks.getPurchase.mockResolvedValue(null)
	mocks.emit.mockResolvedValue(undefined)
})
describe('production buy-path ingest wiring', () => {
	it('emits signed server-known ids and ignores an untrusted product override', async () => {
		expect(
			(await POST(request({ ...payload, productId: 'forged_product' }))).status,
		).toBe(204)
		expect(mocks.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				productId: 'product_fixture',
				userId: 'user_fixture',
			}),
			'client_returned',
			expect.objectContaining({ source: 'client' }),
		)
	})
	it('rejects extra identity fields and malformed body', async () => {
		const bad = new NextRequest('https://app.example/api/telemetry/buy-path', {
			method: 'POST',
			headers: { origin: 'https://app.example' },
			body: '{',
		})
		expect((await POST(bad)).status).toBe(400)
		expect(
			(await POST(request({ ...payload, email: 'synthetic@example.test' })))
				.status,
		).toBe(400)
		expect(mocks.emit).not.toHaveBeenCalled()
	})
	it('limits requests with the shared limiter and fails closed when it is unavailable', async () => {
		mocks.limit.mockResolvedValue({ success: false })
		expect((await POST(request())).status).toBe(429)
		expect(mocks.limit).toHaveBeenCalledWith('192.0.2.1')
		mocks.limit.mockRejectedValue(Error('unavailable'))
		expect((await POST(request())).status).toBe(503)
		expect(mocks.emit).not.toHaveBeenCalled()
	})
	it('rejects a forged or another checkout cookie', async () => {
		expect((await POST(request(payload, 'forged'))).status).toBe(403)
		const other = signBuyPathToken(
			{ ...context, buyPathId: 'cs_test_other' },
			'test-auth-secret',
		)
		expect((await POST(request(payload, other))).status).toBe(403)
		expect(mocks.getPurchase).not.toHaveBeenCalled()
	})
})
