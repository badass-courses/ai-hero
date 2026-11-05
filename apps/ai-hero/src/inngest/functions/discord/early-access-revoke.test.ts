import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
	remove: vi.fn(async () => ({ success: true })),
	findMany: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			entitlementTypes: {
				findFirst: async () => ({ id: 'discord-type' }),
				findMany: async () => [{ id: 'discord-type' }],
			},
			entitlements: { findMany: f.findMany },
		},
		update: () => ({ set: () => ({ where: async () => {} }) }),
	},
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (_config: any, triggers: any, handler: any) => ({
			triggers,
			handler,
		}),
	},
}))
vi.mock('@/lib/discord-utils', () => ({ removeDiscordRole: f.remove }))
vi.mock('@/lib/discord-query', () => ({ getDiscordAccount: vi.fn() }))
vi.mock('@/lib/entitlements', () => ({
	EntitlementSourceType: { PURCHASE: 'PURCHASE' },
}))
vi.mock('@/server/logger', () => ({ log: f.log }))
import { removePurchaseRoleDiscord } from './remove-purchase-role-discord'
const workflow = removePurchaseRoleDiscord as unknown as {
	handler: (input: any) => Promise<any>
}
const purchase = {
	id: 'early_in_test',
	userId: 'u',
	productId: 'product',
	status: 'Refunded',
	merchantChargeId: null,
	fields: { earlyAccess: true, invoiceId: 'in_test' },
}
function run(current: any = purchase) {
	return workflow.handler({
		event: {
			name: 'aihero/early-access.revoke',
			data: { purchaseId: purchase.id, invoiceId: 'in_test' },
		},
		step: { run: async (_name: string, fn: () => unknown) => fn() },
		db: {
			getPurchase: async () => current,
			getUserById: async () => ({ id: 'u' }),
			getProduct: async () => ({ type: 'cohort' }),
		},
	})
}
beforeEach(() => {
	vi.clearAllMocks()
	f.findMany
		.mockResolvedValueOnce([
			{
				id: 'e',
				sourceType: 'PURCHASE',
				sourceId: purchase.id,
				entitlementType: 'discord-type',
				metadata: { discordRoleId: 'role' },
				deletedAt: new Date(),
			},
		])
		.mockResolvedValueOnce([])
})
describe('early-access Discord revocation', () => {
	it('removes roles even if refund cleanup already soft-deleted grant entitlements', async () => {
		expect((await run()).rolesRemoved).toBe(1)
		expect(f.remove).toHaveBeenCalledWith('u', 'role')
		const query = new MySqlDialect().sqlToQuery(
			f.findMany.mock.calls[0]![0].where,
		)
		expect(query.sql).not.toContain('deletedAt')
	})
	it('retains a role still granted by another live purchase', async () => {
		f.findMany
			.mockReset()
			.mockResolvedValueOnce([
				{
					id: 'e',
					sourceType: 'PURCHASE',
					sourceId: purchase.id,
					entitlementType: 'discord-type',
					metadata: { discordRoleId: 'role' },
				},
			])
			.mockResolvedValueOnce([
				{
					id: 'other',
					sourceType: 'PURCHASE',
					sourceId: 'other-purchase',
					metadata: { discordRoleId: 'role' },
				},
			])
		expect((await run()).rolesRemoved).toBe(0)
		expect(f.remove).not.toHaveBeenCalled()
	})
	it('rejects a paid or mismatched purchase before touching Discord', async () => {
		await expect(
			run({ ...purchase, merchantChargeId: 'paid-charge' }),
		).rejects.toThrow('identity/status mismatch')
		expect(f.remove).not.toHaveBeenCalled()
	})
})
