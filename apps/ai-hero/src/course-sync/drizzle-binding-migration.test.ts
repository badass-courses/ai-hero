import { describe, expect, it, vi } from 'vitest'

import {
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005 as v8,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V6 as v6,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V7 as v7,
} from './types'

const runIdentity = vi.hoisted(() => ({
	vercelEnv: null,
	nodeEnv: 'test',
	onVercel: false,
	inngest: 'cloud' as const,
	hostname: 'migration.example.test',
	gitSha: null,
	dbHost: 'db.example.test',
	dbUsername: 'observer',
}))
vi.mock('@/server/run-identity', () => ({ getRunIdentity: () => runIdentity }))

const transaction = vi.hoisted(() => vi.fn())
const findBinding = vi.hoisted(() => vi.fn())
vi.mock('@/db', () => ({
	db: { transaction, query: { courseSyncBinding: { findFirst: findBinding } } },
}))
vi.mock('@/server/logger', () => ({
	log: {
		info: vi.fn(async () => undefined),
		error: vi.fn(async () => undefined),
	},
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

describe('drizzle stored binding migration to v8', () => {
	it.each([v6, v7])(
		'migrates exact v$contractVersion and writes its ledger row',
		async (old) => {
			findBinding.mockResolvedValue({ binding: structuredClone(old) })
			const { updates, ledgerRows } = fakeTransaction(structuredClone(old))
			await expect(
				drizzleCourseSyncPersistence.ensureBinding(v8),
			).resolves.toEqual(v8)
			expect(updates).toEqual([expect.objectContaining({ binding: v8 })])
			expect(ledgerRows).toEqual([
				expect.objectContaining({
					bindingId: v8.bindingId,
					stage: 'migration',
					outcome: 'succeeded',
					runId: `binding-migration:${v8.bindingId}:v${old.contractVersion}-v8`,
					metadata: {
						runIdentity,
						fromContractVersion: old.contractVersion,
						toContractVersion: 8,
					},
				}),
			])
		},
	)

	it('is a no-op for a stored v8 row', async () => {
		transaction.mockClear()
		findBinding.mockResolvedValue({ binding: structuredClone(v8) })
		await expect(
			drizzleCourseSyncPersistence.ensureBinding(v8),
		).resolves.toEqual(v8)
		expect(transaction).not.toHaveBeenCalled()
	})

	it('refuses an unknown stored version', async () => {
		transaction.mockClear()
		findBinding.mockResolvedValue({
			binding: { ...structuredClone(v7), contractVersion: 99 },
		})
		await expect(
			drizzleCourseSyncPersistence.ensureBinding(v8),
		).rejects.toMatchObject({
			code: 'IMMUTABLE_BINDING_CONFLICT',
		})
		expect(transaction).not.toHaveBeenCalled()
	})
})
