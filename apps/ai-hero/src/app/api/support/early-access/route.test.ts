import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
	grant: vi.fn(async () => ({ state: 'ready' })),
	revoke: vi.fn(async () => ({ state: 'revoke_ready' })),
	report: vi.fn(async () => ({ state: 'report', grants: [] })),
	log: { info: vi.fn(), error: vi.fn() },
}))
vi.mock('@/env.mjs', () => ({
	env: { SUPPORT_WEBHOOK_SECRET: 'synthetic-secret' },
}))
vi.mock('@/lib/team-invoice/early-access', () => ({
	grantEarlyAccess: f.grant,
	revokeEarlyAccess: f.revoke,
}))
vi.mock('@/lib/team-invoice/early-access-server', () => ({
	earlyAccessPorts: {},
	reportEarlyAccess: f.report,
}))
vi.mock('@/server/logger', () => ({ log: f.log }))
import { POST } from './route'
function request(input: unknown, signed = true) {
	const body = JSON.stringify(input),
		timestamp = Math.floor(Date.now() / 1000)
	const signature = createHmac('sha256', 'synthetic-secret')
		.update(`${timestamp}.${body}`)
		.digest('hex')
	return new NextRequest('https://www.aihero.dev/api/support/early-access', {
		method: 'POST',
		body,
		headers: signed
			? { 'x-support-signature': `timestamp=${timestamp},v1=${signature}` }
			: {},
	})
}
beforeEach(() => {
	vi.clearAllMocks()
})
describe('signed early-access support endpoint', () => {
	it('rejects unsigned operations without touching fulfillment', async () => {
		expect(
			(
				await POST(
					request(
						{ command: 'grant', invoiceId: 'in_test', apply: true },
						false,
					),
				)
			).status,
		).toBe(401)
		expect(f.grant).not.toHaveBeenCalled()
	})
	it('defaults to dry-run and validates invoice IDs', async () => {
		expect(
			(await POST(request({ command: 'grant', invoiceId: 'in_test' }))).status,
		).toBe(200)
		expect(f.grant).toHaveBeenCalledWith({}, 'in_test', false)
		expect(
			(await POST(request({ command: 'grant', invoiceId: 'bad' }))).status,
		).toBe(400)
	})
	it('report refuses apply and returns only read-only report', async () => {
		expect(
			(await POST(request({ command: 'report', apply: true }))).status,
		).toBe(400)
		expect((await POST(request({ command: 'report' }))).status).toBe(200)
		expect(f.report).toHaveBeenCalledTimes(1)
	})
	it('returns DOUBLE and a non-2xx status for a simulated overlap', async () => {
		f.grant.mockRejectedValueOnce(
			new Error(
				'DOUBLE: grant/payment overlap for in_test; operator review required',
			),
		)
		const response = await POST(
			request({ command: 'grant', invoiceId: 'in_test', apply: true }),
		)
		expect(response.status).toBe(409)
		expect((await response.json()).state).toBe('DOUBLE')
	})
	it('does not leak provider messages, customer emails or credentials', async () => {
		f.grant.mockRejectedValueOnce(
			new Error('Stripe request failed for customer@example.test secret-value'),
		)
		const response = await POST(
			request({ command: 'grant', invoiceId: 'in_test', apply: true }),
		)
		const text = JSON.stringify(await response.json())
		expect(text).not.toContain('customer@')
		expect(text).not.toContain('secret-value')
	})
})
