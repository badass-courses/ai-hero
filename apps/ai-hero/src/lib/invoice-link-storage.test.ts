import { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
	version: null as number | null,
	readbackMismatch: false,
	inserts: [] as Record<string, unknown>[],
	increments: [] as string[],
}))
vi.mock('@/db', () => {
	const tx = {
		query: {
			invoiceSettings: {
				findFirst: async () =>
					store.version === null
						? undefined
						: { linkVersion: store.readbackMismatch ? 1 : store.version },
			},
		},
		insert: () => ({
			values: (values: {
				purchaseId: string
				merchantChargeId: string
				linkVersion: number
			}) => ({
				onDuplicateKeyUpdate: async ({
					set,
				}: {
					set: { linkVersion: SQL }
				}) => {
					store.inserts.push(values)
					store.increments.push(
						new MySqlDialect().sqlToQuery(set.linkVersion).sql,
					)
					store.version =
						store.version === null ? values.linkVersion : store.version + 1
				},
			}),
		}),
	}
	return {
		db: {
			...tx,
			transaction: async (
				work: (transaction: typeof tx) => Promise<unknown>,
			) => {
				const previous = store.version
				try {
					return await work(tx)
				} catch (error) {
					store.version = previous
					throw error
				}
			},
		},
	}
})
import { drizzleInvoiceLinkDataSource } from './invoice-links'

beforeEach(() => {
	store.version = null
	store.readbackMismatch = false
	store.inserts = []
	store.increments = []
})

describe('invoice link version adapter with synthetic DB boundary', () => {
	it('uses version 1 only when there is no details row', async () => {
		expect(
			await drizzleInvoiceLinkDataSource.loadVersion('purchase-a', 'mc_a'),
		).toBe(1)
		store.version = 0
		expect(
			await drizzleInvoiceLinkDataSource.loadVersion('purchase-a', 'mc_a'),
		).toBe(0)
	})
	it('first rotation inserts version 2 and later rotations use an atomic column increment', async () => {
		expect(
			await drizzleInvoiceLinkDataSource.rotateVersion('purchase-a', 'mc_a'),
		).toBe(2)
		expect(
			await drizzleInvoiceLinkDataSource.rotateVersion('purchase-a', 'mc_a'),
		).toBe(3)
		expect(store.inserts).toEqual([
			{ purchaseId: 'purchase-a', merchantChargeId: 'mc_a', linkVersion: 2 },
			{ purchaseId: 'purchase-a', merchantChargeId: 'mc_a', linkVersion: 2 },
		])
		for (const sql of store.increments) {
			expect(sql).toContain('`linkVersion` + 1')
			expect(sql).not.toContain('recipientName')
		}
	})
	it('throws inside the transaction on a bad readback, allowing rollback', async () => {
		store.version = 5
		store.readbackMismatch = true
		await expect(
			drizzleInvoiceLinkDataSource.rotateVersion('purchase-a', 'mc_a'),
		).rejects.toThrow('could not be verified')
		expect(store.version).toBe(5)
	})
})
