import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	rows: vi.fn(),
	logError: vi.fn(),
	inserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: mocks.rows,
				limit: mocks.rows,
			}),
		}),
	},
}))
vi.mock('@/db/schema', () => ({
	purchaseTransferSamePerson: { transferId: 'samePerson.transferId' },
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.logError } }))
vi.mock('drizzle-orm', () => ({
	inArray: (...values: unknown[]) => values,
	sql: (...values: unknown[]) => values,
}))

import {
	isMissingTableError,
	loadSamePersonEvidence,
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

const row = (over: Record<string, unknown> = {}) => ({
	transferId: 't1',
	verifiedBy: 'owner-mailbox-both',
	reason: 'Support confirmed both mailboxes',
	proofRef: 'proof-1',
	...over,
})

describe('same-person evidence reader', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('returns valid evidence by transfer id', async () => {
		mocks.rows.mockResolvedValue([row()])
		const evidence = await loadSamePersonEvidence(['t1'])
		expect(evidence.get('t1')).toEqual({
			verifiedBy: 'owner-mailbox-both',
			reason: 'Support confirmed both mailboxes',
			proofRef: 'proof-1',
		})
	})

	it('drops rows that fail validation: a malformed row is no flag', async () => {
		mocks.rows.mockResolvedValue([
			row({ transferId: 't1', reason: ' ' }),
			row({ transferId: 't2', verifiedBy: 'matching-emails' }),
			row({ transferId: 't3', proofRef: '' }),
		])
		expect((await loadSamePersonEvidence(['t1', 't2', 't3'])).size).toBe(0)
	})

	it('does not query for no transfers', async () => {
		await loadSamePersonEvidence([])
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
		await loadSamePersonEvidence(['t1'])
		await loadSamePersonEvidence(['t2'])
		expect(mocks.logError.mock.calls.length).toBeLessThanOrEqual(1)
	})

	it('rethrows any other database error', async () => {
		mocks.rows.mockRejectedValue(new Error('connection reset'))
		await expect(loadSamePersonEvidence(['t1'])).rejects.toThrow('connection reset')
	})

	it('recognizes a missing table through wrapped causes only', () => {
		expect(isMissingTableError(missingTable)).toBe(true)
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
