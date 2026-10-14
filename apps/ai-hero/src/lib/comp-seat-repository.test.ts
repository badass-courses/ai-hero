import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'
import {
	buildCompSeatPlan,
	executeCompSeatPlan,
	compSeatPlanHash,
} from './comp-seat'

const state = vi.hoisted(() => ({
	database: undefined as unknown,
	sent: vi.fn(async (_event: unknown) => undefined),
}))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: state.sent } }))
import { createCompSeatRepository } from './comp-seat-repository'
import { EntitlementSourceType } from './entitlements'
import * as schema from '@/db/schema'

function fixture(
	options: {
		role?: string | null
		workshops?: string[]
		failEntitlement?: boolean
		existing?: boolean
	} = {},
) {
	const writes: Array<{ table: string; row: Record<string, unknown> }> = []
	const committed: typeof writes = []
	let purchase: Record<string, unknown> | null = options.existing
		? { id: 'test-existing' }
		: null
	const query = {
		products: {
			findFirst: async () => ({
				id: 'test-product',
				type: 'cohort',
				fields: options.role ? { discordRoleId: options.role } : {},
			}),
		},
		users: { findFirst: vi.fn(async () => ({ id: 'test-user' })) },
		purchases: { findFirst: async () => purchase },
		organization: { findFirst: async () => null },
		organizationMemberships: { findFirst: async () => null },
		roles: { findFirst: async () => null },
		organizationMembershipRoles: { findFirst: async () => null },
		entitlementTypes: { findFirst: async () => ({ id: 'test-type' }) },
	}
	const executor = {
		query,
		select: () => ({
			from: (table: unknown) => {
				const chain = {
					innerJoin: () => chain,
					where: () => ({
						then: (resolve: (rows: unknown[]) => unknown) =>
							resolve(
								table === schema.contentResourceProduct
									? [{ id: 'test-cohort' }]
									: (options.workshops ?? ['test-workshop']).map((id) => ({
											id,
										})),
							),
						for: async () => [{ id: 'test-user' }],
					}),
				}
				return chain
			},
		}),
		insert: (table: Parameters<typeof getTableName>[0]) => ({
			values: async (row: Record<string, unknown>) => {
				if (options.failEntitlement && table === schema.entitlements)
					throw new Error('synthetic insert failure')
				writes.push({ table: getTableName(table), row })
			},
		}),
	}
	state.database = {
		...executor,
		transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
			const offset = writes.length
			try {
				const result = await operation(executor)
				committed.push(...writes.slice(offset))
				purchase =
					writes
						.slice(offset)
						.find((item) => item.table === getTableName(schema.purchases))
						?.row ?? purchase
				return result
			} catch (error) {
				writes.splice(offset)
				throw error
			}
		},
	}
	return { committed, query }
}
beforeEach(() => {
	state.sent.mockClear()
})

describe('comp seat transaction adapter', () => {
	it('uses the transaction helper with planned ids and PURCHASE sources; personal org, membership, owner and learner roles are in the same transaction', async () => {
		const { committed, query } = fixture({ role: 'test-role' })
		const repository = createCompSeatRepository()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'synthetic comp',
		)
		expect(committed).toEqual([])
		await executeCompSeatPlan(repository, plan, compSeatPlanHash(plan))
		const purchase = committed.find(
			(item) => item.table === getTableName(schema.purchases),
		)!.row
		expect(purchase).toEqual(plan.users[0]!.purchase)
		const grants = committed
			.filter((item) => item.table === getTableName(schema.entitlements))
			.map((item) => item.row)
		expect(grants).toEqual(
			plan.users[0]!.entitlements.map((row) => ({
				...row,
				expiresAt: undefined,
			})),
		)
		expect(
			grants.every(
				(grant) => grant.sourceType === EntitlementSourceType.PURCHASE,
			),
		).toBe(true)
		expect(
			committed
				.filter((item) => item.table === getTableName(schema.roles))
				.map((item) => item.row.name),
		).toEqual(['owner', 'learner'])
		expect(query.users.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ columns: { id: true } }),
		)
		expect(state.sent.mock.calls).toEqual([[plan.users[0]!.discordEvent]])
		const rerun = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'synthetic comp',
		)
		const count = committed.length
		await executeCompSeatPlan(repository, rerun, compSeatPlanHash(rerun))
		expect(committed).toHaveLength(count)
		expect(state.sent).toHaveBeenCalledOnce()
	})
	it('rolls back the purchase and organization rows if an entitlement insert fails; emits no events', async () => {
		const { committed } = fixture({ role: 'test-role', failEntitlement: true })
		const repository = createCompSeatRepository()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'synthetic comp',
		)
		const result = await executeCompSeatPlan(
			repository,
			plan,
			compSeatPlanHash(plan),
		)
		expect(result.counts.failed).toBe(1)
		expect(committed).toEqual([])
		expect(state.sent).not.toHaveBeenCalled()
	})
	it('does nothing for Discord without a product role, with no env fallback', async () => {
		const { committed } = fixture()
		const repository = createCompSeatRepository()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'synthetic comp',
		)
		const result = await executeCompSeatPlan(
			repository,
			plan,
			compSeatPlanHash(plan),
		)
		expect(result.users[0]!.discord).toBe('not_configured')
		expect(
			committed.filter(
				(item) => item.table === getTableName(schema.entitlements),
			),
		).toHaveLength(1)
		expect(state.sent).not.toHaveBeenCalled()
	})
	it('enrolls an empty cohort with a no-content anchor so the existing sync can find the purchaser later', async () => {
		fixture({ workshops: [] })
		const plan = await buildCompSeatPlan(
			createCompSeatRepository(),
			'test-product',
			['test-user'],
			'synthetic comp',
		)
		expect(plan.users[0]!.entitlements).toMatchObject([
			{
				sourceType: EntitlementSourceType.PURCHASE,
				metadata: {
					contentIds: [],
					earlyAccess: true,
					cohortId: 'test-cohort',
				},
			},
		])
	})
	it('skips ANY existing product purchase regardless of status', async () => {
		const { committed } = fixture({ existing: true })
		const repository = createCompSeatRepository()
		const plan = await buildCompSeatPlan(
			repository,
			'test-product',
			['test-user'],
			'synthetic comp',
		)
		await executeCompSeatPlan(repository, plan, compSeatPlanHash(plan))
		expect(plan.users[0]!.outcome).toBe('skipped_existing_purchase')
		expect(committed).toEqual([])
	})
})
