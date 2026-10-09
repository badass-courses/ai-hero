import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	revoke: vi.fn(),
	restore: vi.fn(),
	lose: vi.fn(),
	removeDiscordRole: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
vi.mock('@/lib/purchase-disputes', () => ({
	revokeDisputedPurchaseAccess: mocks.revoke,
	restoreDisputedPurchaseAccess: mocks.restore,
	applyLostDispute: mocks.lose,
}))
vi.mock('@/lib/discord-utils', () => ({
	removeDiscordRole: mocks.removeDiscordRole,
}))
vi.mock('@/inngest/functions/discord/add-discord-role-workflow', () => ({
	USER_ADDED_TO_COHORT_EVENT: 'cohort/user-added',
	USER_ADDED_TO_WORKSHOP_EVENT: 'workshop/user-added',
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import {
	PURCHASE_DISPUTE_CLOSED_EVENT,
	PURCHASE_DISPUTE_OPENED_EVENT,
} from '@/inngest/events/purchase-dispute'

import {
	purchaseDisputeClosed,
	purchaseDisputeOpened,
} from './purchase-dispute-access'

type Handler = (args: Record<string, unknown>) => Promise<unknown>
const run = (fn: unknown, data: Record<string, unknown>) => {
	const sent: unknown[] = []
	const step = {
		run: async (_id: string, work: () => Promise<unknown>) => work(),
		sendEvent: async (_id: string, payload: unknown) => {
			sent.push(payload)
		},
	}
	const result = (fn as { handler: Handler }).handler({
		event: { data },
		step,
	})
	return { result, sent }
}

const base = {
	stripeChargeId: 'ch_fixture',
	stripeDisputeId: 'du_fixture',
	purchaseId: 'purchase-fixture',
}
const record = {
	stripeDisputeId: 'du_fixture',
	previousStatus: 'Valid',
	revokedAt: '2026-10-09T12:00:00.000Z',
	revokedEntitlementIds: ['content', 'discord'],
}
const revoked = {
	kind: 'revoked',
	purchaseId: base.purchaseId,
	userId: 'buyer',
	record,
	discordRoles: [
		{ entitlementId: 'discord', discordRoleId: 'role-1', kind: 'cohort' },
	],
	isBulk: false,
}

describe('purchase dispute access functions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.removeDiscordRole.mockResolvedValue({ status: 'success' })
	})

	it('subscribes to the commerce dispute events', () => {
		expect((purchaseDisputeOpened as any).trigger).toEqual({
			event: PURCHASE_DISPUTE_OPENED_EVENT,
		})
		expect((purchaseDisputeClosed as any).trigger).toEqual({
			event: PURCHASE_DISPUTE_CLOSED_EVENT,
		})
	})

	it('created: revokes access with the status commerce read and removes Discord roles', async () => {
		mocks.revoke.mockResolvedValue(revoked)
		const { result } = run(purchaseDisputeOpened, {
			...base,
			previousStatus: 'Restricted',
		})

		await expect(result).resolves.toBe(revoked)
		expect(mocks.revoke).toHaveBeenCalledWith({
			purchaseId: base.purchaseId,
			stripeDisputeId: base.stripeDisputeId,
			previousStatus: 'Restricted',
		})
		expect(mocks.removeDiscordRole).toHaveBeenCalledWith('buyer', 'role-1')
	})

	it('created retry after a win: an already revoked dispute with no roles left removes nothing', async () => {
		mocks.revoke.mockResolvedValue({
			kind: 'already-revoked',
			purchaseId: base.purchaseId,
			userId: 'buyer',
			record: { ...record, outcome: 'won' },
			discordRoles: [],
		})
		await run(purchaseDisputeOpened, { ...base, previousStatus: 'Disputed' })
			.result
		expect(mocks.removeDiscordRole).not.toHaveBeenCalled()
	})

	it('throws on a failed Discord removal so Inngest retries the step', async () => {
		mocks.revoke.mockResolvedValue(revoked)
		mocks.removeDiscordRole.mockResolvedValue({
			status: 'error',
			reason: 'discord 503',
		})
		await expect(
			run(purchaseDisputeOpened, { ...base, previousStatus: 'Valid' }).result,
		).rejects.toThrow('discord role removal failed: discord 503')
	})

	it('won: restores access and re-adds the Discord roles it took', async () => {
		mocks.restore.mockResolvedValue({
			kind: 'restored',
			purchaseId: base.purchaseId,
			userId: 'buyer',
			record: { ...record, outcome: 'won' },
			restoredEntitlementIds: ['content', 'discord'],
			discordRoles: revoked.discordRoles,
		})
		const { result, sent } = run(purchaseDisputeClosed, {
			...base,
			previousStatus: 'Disputed',
			disputeStatus: 'won',
			outcome: 'won',
		})

		await result
		expect(mocks.restore).toHaveBeenCalledWith({
			purchaseId: base.purchaseId,
			stripeDisputeId: base.stripeDisputeId,
		})
		expect(mocks.lose).not.toHaveBeenCalled()
		expect(sent).toEqual([
			{
				name: 'cohort/user-added',
				data: {
					cohortId: base.purchaseId,
					userId: 'buyer',
					discordRoleId: 'role-1',
				},
			},
		])
	})

	it('lost retry: removes recorded roles even when the revocation already committed', async () => {
		mocks.removeDiscordRole.mockResolvedValue({ status: 'skipped' })
		mocks.lose.mockResolvedValue({
			kind: 'blocked',
			purchaseId: base.purchaseId,
			userId: 'buyer',
			revocation: {
				kind: 'already-revoked',
				purchaseId: base.purchaseId,
				userId: 'buyer',
				record,
				discordRoles: revoked.discordRoles,
			},
			block: {
				reason: 'chargeback_lost',
				purchaseId: base.purchaseId,
				stripeDisputeId: base.stripeDisputeId,
				blockedAt: '2026-10-09T12:00:00.000Z',
			},
			alreadyBlocked: true,
		})
		await run(purchaseDisputeClosed, {
			...base,
			previousStatus: 'Disputed',
			disputeStatus: 'lost',
			outcome: 'lost',
		}).result
		expect(mocks.removeDiscordRole).toHaveBeenCalledWith('buyer', 'role-1')
	})

	it('lost: keeps the cut, blocks the buyer, and removes roles the late revocation took', async () => {
		mocks.lose.mockResolvedValue({
			kind: 'blocked',
			purchaseId: base.purchaseId,
			userId: 'buyer',
			revocation: revoked,
			block: {
				reason: 'chargeback_lost',
				purchaseId: base.purchaseId,
				stripeDisputeId: base.stripeDisputeId,
				blockedAt: '2026-10-09T12:00:00.000Z',
			},
			alreadyBlocked: false,
		})
		const { result, sent } = run(purchaseDisputeClosed, {
			...base,
			previousStatus: 'Valid',
			disputeStatus: 'lost',
			outcome: 'lost',
		})

		await result
		expect(mocks.lose).toHaveBeenCalledWith({
			purchaseId: base.purchaseId,
			stripeDisputeId: base.stripeDisputeId,
			previousStatus: 'Valid',
		})
		expect(mocks.restore).not.toHaveBeenCalled()
		expect(mocks.removeDiscordRole).toHaveBeenCalledWith('buyer', 'role-1')
		expect(sent).toEqual([])
		expect(mocks.log.info).toHaveBeenCalledWith(
			'purchase_dispute.buyer_blocked',
			expect.objectContaining({ result: 'blocked', alreadyBlocked: false }),
		)
	})
})
