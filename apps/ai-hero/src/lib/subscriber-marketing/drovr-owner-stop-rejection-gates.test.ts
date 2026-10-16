import { describe, expect, it, vi } from 'vitest'
import { createDrizzleDrovrOutboxStore } from './drovr-outbox-drizzle'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import { buildOwnerStopRejection } from './drovr-owner-stop-rejection'

vi.mock('./drovr-unsubscribe-supersession', async (load) => ({
	...(await load<typeof import('./drovr-unsubscribe-supersession')>()),
	closeSupersededUnsubscribeRows: async (
		_db: unknown,
		_target: string,
		rows: unknown[],
	) => rows,
}))
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }))

function rowFixture() {
	const target = 'synthetic-gate-target'
	const at = '2026-10-16T12:00:00.000Z'
	const decidedAt = '2026-10-16T12:01:00.000Z'
	const body = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'crash-course-evergreen-offer',
		idempotencyKey: 'owner:synthetic:purchase',
		type: 'purchase.recorded',
		occurredAt: at,
	} as const
	const entry = outboxEntryForEvent(body, 'bulkIngest')
	const dedupeKey = drovrOutboxDedupeKey(target, entry)
	const receipt = buildOwnerStopRejection({
		target,
		entry,
		problem: { code: 'cold-start-never-born' },
		httpStatus: 409,
		rejectedAttempt: {
			runId: 'synthetic-run',
			requestId: '10000000-0000-4000-8000-000000000001',
			stepKey: dedupeKey,
			attempt: 0,
		},
		decidedAt,
	})
	return {
		id: 'synthetic-row',
		target,
		dedupeKey,
		...entry,
		status: 'rejected',
		nextAttemptAt: new Date(decidedAt),
		lastAttemptAt: new Date(decidedAt),
		lastStatus: 409,
		lastError: 'operator prose',
		heldContinuation: { v: 1, ownerStopRejection: receipt } as unknown,
	}
}
function storeFor(rows: unknown[], missingOnce = false) {
	let reads = 0
	const db = {
		select: vi.fn(() => ({
			from: () => ({
				where: async () => {
					reads++
					if (missingOnce && reads === 1)
						throw Object.assign(
							new Error(
								"Unknown column 'AI_DrovrOutbox.heldContinuation' in 'field list'",
							),
							{ errno: 1054 },
						)
					return missingOnce
						? rows.map((value) => ({
								...(value as object),
								heldContinuation: undefined,
							}))
						: rows
				},
			}),
		})),
	}
	return {
		db,
		store: createDrizzleDrovrOutboxStore(
			db as unknown as Parameters<typeof createDrizzleDrovrOutboxStore>[0],
		),
	}
}
const gates = (rows: unknown[], missingOnce = false) =>
	storeFor(rows, missingOnce).store.openGates({
		target: 'synthetic-gate-target',
		contactIds: ['synthetic-contact'],
	})

describe('actual DAO typed owner-rejection gate boundary', () => {
	it('excludes a Schema-valid full-scope terminal rejection', async () => {
		expect(await gates([rowFixture()])).toEqual([])
	})
	it.each([
		['missing', undefined, 'missing-receipt'],
		['malformed', { v: 1, ownerStopRejection: { v: 1 } }, 'malformed-receipt'],
	] as const)(
		'retains %s proof despite a lookalike lastError and reports why',
		async (_label, heldContinuation, issue) => {
			const row = rowFixture()
			row.heldContinuation = heldContinuation
			row.lastError =
				'cold-start-never-born: OwnerStopNeverBorn: released, nothing owed'
			expect(await gates([row])).toEqual([
				expect.objectContaining({
					status: 'rejected',
					ownerStopRejectionError: expect.stringContaining(issue),
				}),
			])
		},
	)
	it('retains a copied receipt from another full scope', async () => {
		const row = rowFixture()
		row.contactId = 'different-contact'
		expect(await gates([row])).toEqual([
			expect.objectContaining({
				ownerStopRejectionError: expect.stringContaining('scope-mismatch'),
			}),
		])
	})
	it('never excludes a directory failure', async () => {
		const row = rowFixture()
		row.journeyId = 'contact-directory'
		expect(await gates([row])).toEqual([
			expect.objectContaining({
				ownerStopRejectionError: expect.stringContaining('directory-scope'),
			}),
		])
	})
	it('old-schema readers keep the gate, never infer proof from prose, and do not fail', async () => {
		const row = rowFixture()
		row.lastError = 'cold-start-never-born: released'
		expect(await gates([row], true)).toEqual([
			expect.objectContaining({
				status: 'rejected',
				ownerStopRejectionError: expect.stringContaining('missing-receipt'),
			}),
		])
	})
	it('independent error text cannot alter actual DAO exclusion', async () => {
		for (const lastError of [
			null,
			'',
			'cold-start-never-born: released',
			JSON.stringify(rowFixture().heldContinuation),
			'tenant-mismatch: stop held',
		]) {
			const row = rowFixture()
			expect(await gates([{ ...row, lastError }])).toEqual([])
			expect(
				await gates([{ ...row, lastError, heldContinuation: null }]),
			).toHaveLength(1)
		}
	})
})
