import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verify: vi.fn(),
	initiate: vi.fn(),
	inspect: vi.fn(),
	complete: vi.fn(),
	inspectCompletion: vi.fn(),
	info: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: { SUPPORT_WEBHOOK_SECRET: 'test-secret' } }))
vi.mock('@/lib/support-signature', () => ({ verifySupportSignature: mocks.verify }))
vi.mock('@/purchase-transfer/support-complete', () => ({
	completeSupportPurchaseTransfer: mocks.complete,
	inspectSupportPurchaseTransferCompletion: mocks.inspectCompletion,
}))
vi.mock('@/purchase-transfer/support-initiate', () => ({
	initiateSupportPurchaseTransfer: mocks.initiate,
	inspectSupportPurchaseTransfer: mocks.inspect,
}))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
vi.mock('@/server/with-skill', () => ({ withSkill: (handler: unknown) => handler }))

import { SUPPORT_TRANSFER_REFUSAL_PROMPTS } from '@/purchase-transfer/refusal-prompts'

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

	it('requires an exact transfer id for support completion', async () => {
		vi.resetAllMocks()
		mocks.verify.mockReturnValue({ valid: true })
		const response = await POST(
			request({ ...payload, mode: 'support_complete_dry_run' }),
		)
		expect(response.status).toBe(400)
		expect(mocks.inspectCompletion).not.toHaveBeenCalled()
	})

	it('dispatches guarded support completion without recipient acceptance', async () => {
		vi.resetAllMocks()
		mocks.verify.mockReturnValue({ valid: true })
		mocks.complete.mockResolvedValue({
			state: 'completion_requested',
			transferId: 'transfer-1',
		})
		const response = await POST(
			request({
				...payload,
				mode: 'support_complete',
				transferId: 'transfer-1',
			}),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			state: 'completion_requested',
			transferId: 'transfer-1',
		})
		expect(mocks.complete).toHaveBeenCalledWith({
			purchaseId: 'purchase-1',
			sourceUserId: 'owner-1',
			targetEmail: 'learner@example.com',
			transferId: 'transfer-1',
		})
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

	describe('samePerson evidence', () => {
		const samePerson = {
			verifiedBy: 'owner-mailbox-both',
			reason: 'Support confirmed both mailboxes',
			proofRef: 'proof-1',
		}
		const completeBody = {
			...payload,
			mode: 'support_complete',
			transferId: 'transfer-1',
		}

		it('passes valid evidence to support completion', async () => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			mocks.complete.mockResolvedValue({
				state: 'completion_requested',
				transferId: 'transfer-1',
			})
			const response = await POST(request({ ...completeBody, samePerson }))
			expect(response.status).toBe(200)
			expect(mocks.complete).toHaveBeenCalledWith(
				expect.objectContaining({ transferId: 'transfer-1', samePerson }),
			)
		})

		it('a request without samePerson passes none', async () => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			mocks.complete.mockResolvedValue({
				state: 'completion_requested',
				transferId: 'transfer-1',
			})
			await POST(request(completeBody))
			expect(mocks.complete.mock.calls[0]?.[0]).not.toHaveProperty('samePerson')
		})

		it.each([
			['empty object', {}],
			['legacy owner-mailbox shape', { verifiedBy: 'owner-mailbox', proof: 'x' }],
			['blank reason', { ...samePerson, reason: ' ' }],
			['empty proofRef', { ...samePerson, proofRef: '' }],
			['unknown verifiedBy', { ...samePerson, verifiedBy: 'matching-emails' }],
			['reason over 1000', { ...samePerson, reason: 'r'.repeat(1001) }],
			['proofRef over 255', { ...samePerson, proofRef: 'p'.repeat(256) }],
			['proofRef with an email', { ...samePerson, proofRef: 'a@example.test' }],
			['null', null],
			['true', true],
		])('refuses %s with a literal prompt and no transfer logic', async (_n, bad) => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			const response = await POST(request({ ...completeBody, samePerson: bad }))
			expect(response.status).toBe(400)
			const body = await response.json()
			expect(body.reason).toBe('same_person_evidence_invalid')
			expect(body.error).toContain('verifiedBy')
			expect(mocks.complete).not.toHaveBeenCalled()
		})

		it.each(['invite', 'dry_run'])(
			'%s with samePerson is refused: only support_complete modes carry it',
			async (mode) => {
				vi.resetAllMocks()
				mocks.verify.mockReturnValue({ valid: true })
				const response = await POST(
					request({ ...payload, mode, samePerson }),
				)
				expect(response.status).toBe(400)
				expect((await response.json()).reason).toBe(
					'same_person_only_on_support_complete',
				)
				expect(mocks.initiate).not.toHaveBeenCalled()
				expect(mocks.inspect).not.toHaveBeenCalled()
			},
		)

		it('a completion dry run checks the same evidence against the guards', async () => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			mocks.inspectCompletion.mockResolvedValue({
				state: 'blocked',
				reason: 'same_person_table_missing',
			})
			const response = await POST(
				request({ ...completeBody, mode: 'support_complete_dry_run', samePerson }),
			)
			expect(response.status).toBe(409)
			expect(mocks.inspectCompletion).toHaveBeenCalledWith(
				expect.objectContaining({ samePerson }),
			)
		})
	})

	describe('refusals carry a literal prompt', () => {
		const reasons = Object.keys(SUPPORT_TRANSFER_REFUSAL_PROMPTS)
		it.each(reasons)('409 %s returns reason and its prompt as error', async (reason) => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			mocks.complete.mockResolvedValue({ state: 'blocked', reason })
			const response = await POST(
				request({ ...payload, mode: 'support_complete', transferId: 'transfer-1' }),
			)
			const body = await response.json()
			expect(response.status).toBe(409)
			expect(body).toEqual({
				state: 'blocked',
				reason,
				error: SUPPORT_TRANSFER_REFUSAL_PROMPTS[reason as keyof typeof SUPPORT_TRANSFER_REFUSAL_PROMPTS],
			})
		})

		it.each(['same_person_table_missing', 'same_person_source_not_payer', 'same_person_order_unknown', 'same_person_cannot_be_added_after_claim', 'move_would_change_invoice_payer'])(
			'%s is a 409 with the exact prompt',
			async (reason) => {
				vi.resetAllMocks()
				mocks.verify.mockReturnValue({ valid: true })
				mocks.complete.mockResolvedValue({ state: 'blocked', reason })
				const response = await POST(
					request({ ...payload, mode: 'support_complete', transferId: 'transfer-1' }),
				)
				expect(response.status).toBe(409)
				const body = await response.json()
				expect(body.error).toBe(
					SUPPORT_TRANSFER_REFUSAL_PROMPTS[reason as keyof typeof SUPPORT_TRANSFER_REFUSAL_PROMPTS],
				)
				expect(body.error).toMatch(/^Refused: /)
			},
		)

		it('a pending 202 also carries its prompt', async () => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			mocks.complete.mockResolvedValue({
				state: 'completion_pending',
				transferId: 'transfer-1',
				reason: 'event_publish_failed',
			})
			const response = await POST(
				request({ ...payload, mode: 'support_complete', transferId: 'transfer-1' }),
			)
			expect(response.status).toBe(202)
			expect((await response.json()).error).toBe(
				SUPPORT_TRANSFER_REFUSAL_PROMPTS.event_publish_failed,
			)
		})

		it('limits are in the 400 prompt for malformed evidence', async () => {
			vi.resetAllMocks()
			mocks.verify.mockReturnValue({ valid: true })
			const response = await POST(
				request({
					...payload,
					mode: 'support_complete',
					transferId: 'transfer-1',
					samePerson: {
						verifiedBy: 'owner-mailbox-both',
						reason: 'r',
						proofRef: 'ticket for a@example.test',
					},
				}),
			)
			expect(response.status).toBe(400)
			expect((await response.json()).error).toContain('255')
		})
	})
})
