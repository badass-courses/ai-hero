import { describe, expect, it, vi } from 'vitest'
import {
	buildCompSeatPlan,
	executeCompSeatPlan,
	compSeatPlanHash,
	type CompSeatRepository,
} from './comp-seat'

const context = {
	productId: 'test-product',
	cohortId: 'test-cohort',
	workshopIds: ['workshop-b', 'workshop-a'],
	contentTypeId: 'content-type',
	discordTypeId: 'discord-type',
	discordRoleId: 'test-role',
}
const state = {
	exists: true,
	existingPurchaseId: null,
	organizationId: 'test-org',
	membershipId: 'test-membership',
	organizationRows: [],
}
function rig() {
	const purchased = new Set<string>()
	const writes: unknown[] = []
	const send = vi.fn(async () => undefined)
	const repository: CompSeatRepository = {
		context: async () => context,
		userState: async (userId) => ({
			...state,
			existingPurchaseId: purchased.has(userId) ? 'existing-purchase' : null,
		}),
		transaction: async (userId, operation) => {
			const pending: unknown[] = []
			const result = await operation({
				context: async () => context,
				userState: async () => ({
					...state,
					existingPurchaseId: purchased.has(userId)
						? 'existing-purchase'
						: null,
				}),
				write: async (plan) => {
					pending.push(plan)
					purchased.add(userId)
				},
			})
			writes.push(...pending)
			return result
		},
		send,
	}
	return { repository, writes, send }
}

describe('guarded comp seat plan', () => {
	it('prints stable exact purchase and entitlement rows, deduplicates input, and writes nothing in planning', async () => {
		const { repository, writes, send } = rig()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user', 'test-user'],
			'test reason',
		)
		expect(plan.users).toHaveLength(1)
		expect(plan.users[0]!.purchase).toMatchObject({
			userId: 'test-user',
			productId: 'test-product',
			status: 'Valid',
			totalAmount: '0',
			fields: { source: 'comp', reason: 'test reason', earlyAccess: true },
		})
		expect(plan.users[0]!.entitlements).toHaveLength(3)
		expect(plan.users[0]!.entitlements[0]).toMatchObject({
			userId: 'test-user',
			metadata: {
				contentIds: ['workshop-a'],
				cohortId: 'test-cohort',
				earlyAccess: true,
			},
		})
		expect(compSeatPlanHash(plan)).toBe(
			compSeatPlanHash(
				await buildCompSeatPlan(
					repository,
					'test-product',
					['test-user'],
					'test reason',
				),
			),
		)
		expect(writes).toEqual([])
		expect(send).not.toHaveBeenCalled()
	})
	it('requires the reviewed hash before any write, including changed reason or workshops', async () => {
		const { repository, writes } = rig()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'reason',
		)
		await expect(
			executeCompSeatPlan(repository, plan, 'incorrect'),
		).rejects.toThrow(/PlanMismatch: you .*Accepted: .*Fix: .*Debug:/)
		const altered = { ...plan, reason: 'changed' }
		await expect(
			executeCompSeatPlan(repository, altered, compSeatPlanHash(plan)),
		).rejects.toThrow('PlanMismatch:')
		expect(writes).toEqual([])
	})
	it('commits one user transaction and sends ONLY cohort/user-added, never purchase or coupon events', async () => {
		const { repository, writes, send } = rig()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'reason',
		)
		const result = await executeCompSeatPlan(
			repository,
			plan,
			compSeatPlanHash(plan),
		)
		expect(result.counts.created).toBe(1)
		expect(writes).toHaveLength(1)
		expect(send.mock.calls).toEqual([[plan.users[0]!.discordEvent]])
		expect(plan.users[0]!.discordEvent).toMatchObject({
			name: 'cohort/user-added',
			data: {
				userId: 'test-user',
				cohortId: 'test-cohort',
				discordRoleId: 'test-role',
			},
		})
		const repeated = await executeCompSeatPlan(
			repository,
			plan,
			compSeatPlanHash(plan),
		)
		expect(repeated.counts).toMatchObject({ created: 0, skipped: 1, failed: 0 })
		const rerun = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'reason',
		)
		expect(rerun.users[0]!.outcome).toBe('skipped_existing_purchase')
		await executeCompSeatPlan(repository, rerun, compSeatPlanHash(rerun))
		expect(writes).toHaveLength(1)
		expect(send).toHaveBeenCalledOnce()
	})
	it('does not fall back to another Discord role when none is configured', async () => {
		const { repository, send } = rig()
		repository.context = async () => ({
			...context,
			discordRoleId: null,
			discordTypeId: null,
		})
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'reason',
		)
		expect(plan.users[0]!.discord).toBe('not_configured')
		expect(plan.users[0]!.entitlements).toHaveLength(2)
		expect(plan.users[0]!.discordEvent).toBeNull()
		expect(send).not.toHaveBeenCalled()
	})
	it('refuses stale state inside the user transaction', async () => {
		const { repository, writes } = rig()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'reason',
		)
		repository.transaction = async (_id, operation) =>
			operation({
				context: async () => ({ ...context, workshopIds: ['new-workshop'] }),
				userState: async () => state,
				write: async () => {
					writes.push('bad')
				},
			})
		const result = await executeCompSeatPlan(
			repository,
			plan,
			compSeatPlanHash(plan),
		)
		expect(result.counts.failed).toBe(1)
		expect(writes).toEqual([])
	})
	it('records Discord failure separately from the committed grant', async () => {
		const { repository } = rig()
		repository.send = async () => {
			throw new Error('synthetic delivery failure')
		}
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'reason',
		)
		const result = await executeCompSeatPlan(
			repository,
			plan,
			compSeatPlanHash(plan),
		)
		expect(result.counts.created).toBe(1)
		expect(result.users[0]!.discord).toBe('delivery_failed')
	})
})
