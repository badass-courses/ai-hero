import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verify: vi.fn(),
	initiate: vi.fn(),
	inspect: vi.fn(),
	info: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: { SUPPORT_WEBHOOK_SECRET: 'test-secret' } }))
vi.mock('@/lib/support-signature', () => ({ verifySupportSignature: mocks.verify }))
vi.mock('@/purchase-transfer/support-initiate', () => ({
	initiateSupportPurchaseTransfer: mocks.initiate,
	inspectSupportPurchaseTransfer: mocks.inspect,
}))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
vi.mock('@/server/with-skill', () => ({ withSkill: (handler: unknown) => handler }))

import { POST } from './route'

const payload = {
	mode: 'invite',
	purchaseId: 'purchase-1',
	sourceUserId: 'owner-1',
	targetEmail: 'learner@example.com',
	audit: {
		runId: 'run-1', conversationId: 'cnv-1', operatorId: 'joel',
		approvalReference: 'operator-approval', expectedInboundId: 'msg-1',
	},
}
function request(body: unknown, signature = 'signed') {
	return new Request('https://www.aihero.dev/api/support/purchase-transfer', {
		method: 'POST',
		headers: { 'x-support-signature': signature },
		body: JSON.stringify(body),
	}) as Parameters<typeof POST>[0]
}

describe('support transfer endpoint', () => {
	it('rejects unsigned requests before entering transfer logic', async () => {
		vi.resetAllMocks()
		mocks.verify.mockReturnValue({ valid: false, error: 'Invalid signature' })
		const response = await POST(request(payload, 'bad'))
		expect(response.status).toBe(401)
		expect(mocks.initiate).not.toHaveBeenCalled()
	})

	it('rejects missing audit fields before creating a user', async () => {
		vi.resetAllMocks()
		mocks.verify.mockReturnValue({ valid: true })
		const response = await POST(request({ ...payload, audit: {} }))
		expect(response.status).toBe(400)
		expect(mocks.initiate).not.toHaveBeenCalled()
	})

	it('checks readiness without provisioning or sending mail', async () => {
		vi.resetAllMocks()
		mocks.verify.mockReturnValue({ valid: true })
		mocks.inspect.mockResolvedValue({ state: 'ready', transferId: 'transfer-1', targetEmail: 'private@example.com' })
		const response = await POST(request({ ...payload, mode: 'dry_run' }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ state: 'ready', transferId: 'transfer-1' })
		expect(mocks.initiate).not.toHaveBeenCalled()
	})

	it('reports invited, not completed', async () => {
		vi.resetAllMocks()
		mocks.verify.mockReturnValue({ valid: true })
		mocks.initiate.mockResolvedValue({ state: 'invited', transferId: 'transfer-1' })
		const response = await POST(request(payload))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ state: 'invited', transferId: 'transfer-1' })
		expect(mocks.initiate).toHaveBeenCalledWith({
			purchaseId: 'purchase-1', sourceUserId: 'owner-1', targetEmail: 'learner@example.com',
		})
	})
})
