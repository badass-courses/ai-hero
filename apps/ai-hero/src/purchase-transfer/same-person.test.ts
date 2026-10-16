import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	rows: vi.fn(),
	selectedShape: vi.fn(),
	logError: vi.fn(),
	inserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/db', () => ({
	db: {
		select: (shape?: unknown) => {
			mocks.selectedShape(shape)
			return {
			from: () => ({
				where: mocks.rows,
				limit: mocks.rows,
			}),
			}
		},
	},
}))
vi.mock('@/db/schema', () => ({
	purchaseTransferSamePerson: {
		transferId: 'samePerson.transferId',
		verifiedBy: 'samePerson.verifiedBy',
		reason: 'samePerson.reason',
		proofRef: 'samePerson.proofRef',
	},
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.logError } }))
vi.mock('drizzle-orm', () => ({
	inArray: (...values: unknown[]) => values,
	sql: (...values: unknown[]) => values,
}))

import {
	isMissingTableError,
	loadSamePersonFlags,
	recordSamePersonEvidence,
	samePersonTableExists,
	toTransferFacts,
} from './same-person'

const missingTable = Object.assign(new Error('Failed query'), {
	cause: Object.assign(new Error("Table 'x.AI_PurchaseTransferSamePerson' doesn't exist"), {
		code: 'ER_NO_SUCH_TABLE',
		errno: 1146,
	}),
})

// What the reader query returns: the transfer id, the kind and a verdict on
// reason and proofRef computed in SQL. The text itself never comes back.
const row = (over: Record<string, unknown> = {}) => ({
	transferId: 't1',
	verifiedBy: 'owner-mailbox-both',
	evidenceOk: 1,
	...over,
})

describe('same-person evidence reader', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('returns the flag by transfer id: only the kind, no reason or proofRef', async () => {
		mocks.rows.mockResolvedValue([row()])
		const flags = await loadSamePersonFlags(['t1'])
		expect(flags.get('t1')).toEqual({ verifiedBy: 'owner-mailbox-both' })
		expect(Object.keys(flags.get('t1')!)).toEqual(['verifiedBy'])
	})

	it('selects only the transfer id, the kind and the SQL verdict, never reason or proofRef', async () => {
		mocks.rows.mockResolvedValue([])
		await loadSamePersonFlags(['t1'])
		const shape = mocks.selectedShape.mock.calls[0]?.[0] as Record<string, unknown>
		expect(Object.keys(shape).sort()).toEqual(['evidenceOk', 'transferId', 'verifiedBy'])
	})

	it('drops rows that fail the verdict or name an unknown kind: a malformed row is no flag', async () => {
		mocks.rows.mockResolvedValue([
			row({ transferId: 't1', evidenceOk: 0 }),
			row({ transferId: 't2', verifiedBy: 'matching-emails' }),
			row({ transferId: 't3', evidenceOk: null }),
		])
		expect((await loadSamePersonFlags(['t1', 't2', 't3'])).size).toBe(0)
	})

	it('accepts the verdict as a string from the driver', async () => {
		mocks.rows.mockResolvedValue([row({ evidenceOk: '1' })])
		expect((await loadSamePersonFlags(['t1'])).size).toBe(1)
	})

	it('does not query for no transfers', async () => {
		await loadSamePersonFlags([])
		expect(mocks.rows).not.toHaveBeenCalled()
	})

	it('treats a missing table as no flags and does not throw (deploy before migration)', async () => {
		mocks.rows.mockRejectedValue(missingTable)
		const facts = await toTransferFacts([
			{
				id: 't1',
				transferState: 'COMPLETED',
				sourceUserId: 'A',
				targetUserId: 'A2',
				completedAt: new Date('2026-09-01T00:00:00Z'),
				createdAt: new Date('2026-09-01T00:00:00Z'),
			},
		])
		expect(facts).toHaveLength(1)
		expect(facts[0]?.samePerson).toBeNull()
	})

	it('logs the missing table once per process, not per page view', async () => {
		mocks.rows.mockRejectedValue(missingTable)
		await loadSamePersonFlags(['t1'])
		await loadSamePersonFlags(['t2'])
		expect(mocks.logError.mock.calls.length).toBeLessThanOrEqual(1)
	})

	it('rethrows any other database error', async () => {
		mocks.rows.mockRejectedValue(new Error('connection reset'))
		await expect(loadSamePersonFlags(['t1'])).rejects.toThrow('connection reset')
	})

	it('recognizes a missing table by code or errno through wrapped causes, never by message', () => {
		expect(isMissingTableError(missingTable)).toBe(true)
		expect(isMissingTableError({ errno: 1146 })).toBe(true)
		expect(isMissingTableError({ code: 'ER_NO_SUCH_TABLE' })).toBe(true)
		expect(isMissingTableError(new Error("Table 'x' doesn't exist"))).toBe(false)
		expect(isMissingTableError(new Error('connection reset'))).toBe(false)
		expect(isMissingTableError(null)).toBe(false)
	})
})

describe('same-person evidence writer preflight', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('reports the table missing instead of throwing', async () => {
		mocks.rows.mockRejectedValue(missingTable)
		await expect(samePersonTableExists()).resolves.toBe(false)
	})
	it('reports it present', async () => {
		mocks.rows.mockResolvedValue([])
		await expect(samePersonTableExists()).resolves.toBe(true)
	})
	it('rethrows other errors so a flaky database never reads as missing', async () => {
		mocks.rows.mockRejectedValue(new Error('timeout'))
		await expect(samePersonTableExists()).rejects.toThrow('timeout')
	})

	it('writes only the three evidence fields, trimmed, as an idempotent insert', async () => {
		const upsert = vi.fn()
		const executor = {
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					mocks.inserts.push(values)
					return { onDuplicateKeyUpdate: upsert }
				},
			}),
		}
		await recordSamePersonEvidence(executor as never, 't1', {
			verifiedBy: 'same-stripe-customer',
			reason: '  same customer  ',
			proofRef: ' ref ',
			extra: 'smuggled',
		} as never)
		expect(mocks.inserts.at(-1)).toEqual({
			transferId: 't1',
			verifiedBy: 'same-stripe-customer',
			reason: 'same customer',
			proofRef: 'ref',
		})
		expect(upsert).toHaveBeenCalledTimes(1)
	})
})

describe('only support-complete may write evidence', () => {
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name)
			if (name === 'node_modules') return []
			return statSync(path).isDirectory()
				? walk(path)
				: /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
					? [path]
					: []
		})
	it('only the support endpoint imports the support-complete entry points', () => {
		const offenders = walk(join(__dirname, '..'))
			.filter(
				(file) =>
					!/purchase-transfer\/support-complete\.ts$/.test(file) &&
					!/api\/support\/purchase-transfer\/route\.ts$/.test(file),
			)
			.filter((file) => {
				const source = readFileSync(file, 'utf8')
				return /completeSupportPurchaseTransfer|SupportCompleteInput|inspectSupportPurchaseTransferCompletion/.test(
					source,
				)
			})
		expect(offenders).toEqual([])
	})

	it('no other source file imports the writer or the table', () => {
		const offenders = walk(join(__dirname, '..'))
			.filter((file) => !/purchase-transfer\/(support-complete|same-person)\.ts$/.test(file))
			.filter((file) => !/db\/schema\.ts$/.test(file))
			.filter((file) => {
				const source = readFileSync(file, 'utf8')
				return (
					source.includes('recordSamePersonEvidence') ||
					source.includes('purchaseTransferSamePerson')
				)
			})
		expect(offenders).toEqual([])
	})
})
