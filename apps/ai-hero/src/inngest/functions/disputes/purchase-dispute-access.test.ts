import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	apply: vi.fn(),
	syncRole: vi.fn(),
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
	applyDisputeEvent: mocks.apply,
	syncDisputeDiscordRole: mocks.syncRole,
}))
vi.mock('@/lib/discord-utils', () => ({ discordRoleClient: 'discord-client' }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import {
	PURCHASE_DISPUTE_CLOSED_EVENT,
	PURCHASE_DISPUTE_OPENED_EVENT,
} from '@coursebuilder/commerce/dispute-events'

import {
	purchaseDisputeClosed,
	purchaseDisputeOpened,
} from './purchase-dispute-access'

type Handler = (args: Record<string, unknown>) => Promise<unknown>
const run = (fn: unknown, data: Record<string, unknown>) => {
	const steps: string[] = []
	const step = {
		run: async (id: string, work: () => Promise<unknown>) => {
			steps.push(id)
			return work()
		},
		sleep: async (id: string) => {
			steps.push(id)
		},
	}
	const result = (fn as { handler: Handler }).handler({
		event: { data },
		step,
	})
	return { result, steps }
}

const base = {
	stripeChargeId: 'ch_fixture',
	stripeDisputeId: 'du_fixture',
	purchaseId: 'purchase-fixture',
}
const applied = (overrides: Record<string, unknown> = {}) => ({
	kind: 'applied',
	purchaseId: base.purchaseId,
	from: null,
	to: 'open',
	status: 'Valid',
	plannedStatus: 'Disputed',
	cutEntitlementIds: ['content', 'discord'],
	cutCreditEntitlementIds: [],
	restoreEntitlementIds: [],
	isBulk: false,
	record: { discordRoleIds: ['role-1', 'role-2'] },
	...overrides,
})

describe('purchase dispute functions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.syncRole.mockResolvedValue({
			kind: 'synced',
			result: 'removed',
			verified: true,
		})
	})

	it('subscribe to the commerce lifecycle events', () => {
		expect((purchaseDisputeOpened as any).trigger).toEqual({
			event: PURCHASE_DISPUTE_OPENED_EVENT,
		})
		expect((purchaseDisputeClosed as any).trigger).toEqual({
			event: PURCHASE_DISPUTE_CLOSED_EVENT,
		})
	})

	it('opened applies the event, then syncs each recorded role in its own step', async () => {
		mocks.apply.mockResolvedValue(applied())
		const { result, steps } = run(purchaseDisputeOpened, {
			...base,
			previousStatus: 'Restricted',
		})
		await result
		expect(mocks.apply).toHaveBeenCalledWith({
			purchaseId: base.purchaseId,
			stripeDisputeId: base.stripeDisputeId,
			previousStatus: 'Restricted',
			event: 'opened',
		})
		expect(steps).toEqual([
			'apply dispute opened',
			'sync discord role role-1',
			'sync discord role role-2',
		])
		expect(mocks.syncRole).toHaveBeenCalledWith({
			purchaseId: base.purchaseId,
			stripeDisputeId: base.stripeDisputeId,
			discordRoleId: 'role-1',
			discord: 'discord-client',
		})
	})

	it('verifies an unverified Discord change after a pause and fails until confirmed', async () => {
		mocks.apply.mockResolvedValue(
			applied({ record: { discordRoleIds: ['role-1'] } }),
		)
		mocks.syncRole
			.mockResolvedValueOnce({
				kind: 'synced',
				result: 'removed',
				verified: false,
			})
			.mockResolvedValueOnce({
				kind: 'synced',
				result: 'removed',
				verified: false,
			})
		const first = run(purchaseDisputeOpened, base)
		await expect(first.result).rejects.toThrow('role-1 still unverified')
		expect(first.steps).toEqual([
			'apply dispute opened',
			'sync discord role role-1',
			'sync discord role role-1 settle',
			'sync verify discord role role-1',
		])

		mocks.syncRole
			.mockResolvedValueOnce({
				kind: 'synced',
				result: 'removed',
				verified: false,
			})
			.mockResolvedValueOnce({
				kind: 'synced',
				result: 'removed',
				verified: true,
			})
		await expect(run(purchaseDisputeOpened, base).result).resolves.toBeTruthy()
	})

	it('a failed role sync fails the step so Inngest retries it', async () => {
		mocks.apply.mockResolvedValue(applied())
		mocks.syncRole.mockRejectedValue(
			new Error('discord remove role failed: 503'),
		)
		await expect(run(purchaseDisputeOpened, base).result).rejects.toThrow('503')
	})

	it.each(['won', 'lost'] as const)(
		'%s applies the outcome, syncs roles, then reconciles after racing writes land',
		async (outcome) => {
			mocks.apply
				.mockResolvedValueOnce(applied({ from: 'open', to: outcome }))
				.mockResolvedValueOnce(applied({ kind: 'unchanged', to: outcome }))
			const { result, steps } = run(purchaseDisputeClosed, {
				...base,
				previousStatus: 'Disputed',
				disputeStatus: outcome,
				outcome,
			})
			await result
			expect(steps).toEqual([
				`apply dispute ${outcome}`,
				'sync discord role role-1',
				'sync discord role role-2',
				'let racing status writes land',
				'reconcile dispute',
				'reconcile discord role role-1',
				'reconcile discord role role-2',
			])
			expect(mocks.apply).toHaveBeenLastCalledWith({
				purchaseId: base.purchaseId,
				stripeDisputeId: base.stripeDisputeId,
				event: 'reconcile',
			})
		},
	)

	it('logs held buyer blocks, held statuses and bulk purchases for an operator', async () => {
		mocks.apply
			.mockResolvedValueOnce(
				applied({
					to: 'lost',
					isBulk: true,
					statusHeld: 'original-status-unknown',
					restoreHeld: 'banned',
					buyerOutcome: { status: 'held', reason: 'transfer-chain-ambiguous' },
				}),
			)
			.mockResolvedValueOnce(applied({ kind: 'unchanged', to: 'lost' }))
		await run(purchaseDisputeClosed, {
			...base,
			previousStatus: 'Valid',
			disputeStatus: 'lost',
			outcome: 'lost',
		}).result
		const warnings = mocks.log.warn.mock.calls.map(([name]) => name)
		expect(warnings).toEqual([
			'purchase_dispute.bulk_seats_retained',
			'purchase_dispute.restore_held',
			'purchase_dispute.status_held',
			'purchase_dispute.buyer_block_held',
		])
	})

	it('an ignored event syncs nothing and skips the reconcile', async () => {
		mocks.apply.mockResolvedValue({
			kind: 'ignored',
			purchaseId: base.purchaseId,
			reason: 'different-dispute',
		})
		const { result, steps } = run(purchaseDisputeClosed, {
			...base,
			previousStatus: 'Valid',
			disputeStatus: 'won',
			outcome: 'won',
		})
		await result
		expect(steps).toEqual(['apply dispute won'])
		expect(mocks.syncRole).not.toHaveBeenCalled()
	})
})
