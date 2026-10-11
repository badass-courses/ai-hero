import { describe, expect, it, vi } from 'vitest'

import {
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005 as v7,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V6 as v6,
} from './types'

const transaction = vi.hoisted(() => vi.fn())
const findBinding = vi.hoisted(() => vi.fn())
vi.mock('@/db', () => ({
	db: { transaction, query: { courseSyncBinding: { findFirst: findBinding } } },
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(async () => undefined), error: vi.fn(async () => undefined) },
}))

import { drizzleCourseSyncPersistence } from './drizzle-persistence'

function fakeTransaction(stored: unknown) {
	const updates: unknown[] = []
	const ledgerRows: Array<Record<string, any>> = []
	transaction.mockImplementation(async (callback) =>
		callback({
			select: () => ({
				from: () => ({
					where: () => ({ for: async () => [{ binding: stored }] }),
				}),
			}),
			update: () => ({
				set: (values: unknown) => ({
					where: async () => void updates.push(values),
				}),
			}),
			insert: () => ({
				values: (values: Record<string, any>) => ({
					onDuplicateKeyUpdate: async () => void ledgerRows.push(values),
				}),
			}),
		}),
	)
	return { updates, ledgerRows }
}

describe('drizzle stored binding migration v6 to v7', () => {
	it('migrates a stored v6 row once and writes its ledger row', async () => {
		findBinding.mockResolvedValue({ binding: structuredClone(v6) })
		const { updates, ledgerRows } = fakeTransaction(structuredClone(v6))
		await expect(drizzleCourseSyncPersistence.ensureBinding(v7)).resolves.toEqual(v7)
		expect(updates).toHaveLength(1)
		expect(updates[0]).toMatchObject({ binding: v7 })
		expect(ledgerRows).toHaveLength(1)
		expect(ledgerRows[0]).toMatchObject({
			bindingId: v7.bindingId,
			stage: 'migration',
			outcome: 'succeeded',
			runId: `binding-migration:${v7.bindingId}:v6-v7`,
			metadata: { fromContractVersion: 6, toContractVersion: 7 },
		})
	})

	it('is a no-op for a stored v7 row', async () => {
		transaction.mockClear()
		findBinding.mockResolvedValue({ binding: structuredClone(v7) })
		await expect(drizzleCourseSyncPersistence.ensureBinding(v7)).resolves.toEqual(v7)
		expect(transaction).not.toHaveBeenCalled()
	})

	it('refuses an unknown stored version', async () => {
		transaction.mockClear()
		findBinding.mockResolvedValue({ binding: { ...structuredClone(v6), contractVersion: 99 } })
		await expect(drizzleCourseSyncPersistence.ensureBinding(v7)).rejects.toMatchObject({
			code: 'IMMUTABLE_BINDING_CONFLICT',
		})
		expect(transaction).not.toHaveBeenCalled()
	})
})
