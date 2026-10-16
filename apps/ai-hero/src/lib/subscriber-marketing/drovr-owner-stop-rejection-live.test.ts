import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import { readHeldContinuationEnvelope } from './drovr-outbox-control'
import type { OwnerStopRejectionInput } from './drovr-owner-stop-rejection'
import {
	recordOwnerStopRejectionLive,
	OWNER_STOP_REJECTED_DIAGNOSTIC,
} from './drovr-owner-stop-rejection-live'

const m = vi.hoisted(() => ({
	row: null as any,
	updates: [] as Record<string, unknown>[],
	capture: vi.fn(),
	transaction: vi.fn(),
	missingColumn: false,
	deadlocks: 0,
	warn: vi.fn(),
}))
vi.mock('@/server/logger', () => ({ log: { warn: m.warn } }))
vi.mock('./drovr-outbox-live', () => ({
	captureDrovrOutboxLive: m.capture,
	drovrOutboxTargetFromEnv: () => 'synthetic-target',
}))
vi.mock('@/db', () => {
	const select = (probe = false) => {
		const query: any = {
			from: () => query,
			where: () => query,
			limit: () => query,
			for: () => query,
			then: (yes: any, no: any) =>
				Promise.resolve()
					.then(() => {
						if (probe && m.missingColumn)
							throw Object.assign(
								new Error(
									"Unknown column 'AI_DrovrOutbox.heldContinuation' in 'field list'",
								),
								{ errno: 1054 },
							)
						return m.row ? [m.row] : []
					})
					.then(yes, no),
		}
		return query
	}
	const tx = {
		select: () => select(),
		update: () => ({
			set: (patch: Record<string, unknown>) => ({
				where: async () => {
					m.updates.push(patch)
					Object.assign(m.row, patch)
					return [{ affectedRows: 1 }]
				},
			}),
		}),
	}
	return {
		db: {
			select: () => select(true),
			transaction: (...args: unknown[]) => m.transaction(...args),
		},
		syntheticTx: tx,
	}
})
function fixture(): { input: OwnerStopRejectionInput; row: any } {
	const event = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'crash-course-evergreen-offer',
		idempotencyKey: 'owner:synthetic:purchase',
		type: 'purchase.recorded',
		occurredAt: '2026-10-16T12:00:00.000Z',
	} as const
	const entry = outboxEntryForEvent(event, 'bulkIngest', {
		sentAt: Date.parse(event.occurredAt),
	})
	const target = 'synthetic-target'
	const key = drovrOutboxDedupeKey(target, entry)
	return {
		input: {
			target,
			entry,
			problem: { type: 'urn:drovr:problem:contact-never-born' },
			httpStatus: 409,
			rejectedAttempt: {
				runId: 'synthetic-sdk-run',
				requestId: '10000000-0000-4000-8000-000000000001',
				stepKey: key,
				attempt: 0,
			},
			decidedAt: '2026-10-16T12:01:00.000Z',
		},
		row: {
			...entry,
			id: 'synthetic-row',
			dedupeKey: key,
			target,
			status: 'pending',
			attempts: 0,
			firstFailedAt: event.occurredAt,
			lastAttemptAt: null,
			lastStatus: null,
			lastError: 'earlier error prose',
			heldContinuation: {
				v: 1,
				replayProof: { v: 1, handoffs: 2 },
				continuation: { v: 1, blocked: true, reason: 'synthetic coordinator' },
			},
		},
	}
}
beforeEach(async () => {
	vi.clearAllMocks()
	m.row = fixture().row
	m.updates.length = 0
	m.missingColumn = false
	m.deadlocks = 0
	m.capture.mockResolvedValue({ status: 'outboxed', count: 1 })
	const { syntheticTx } = (await import('@/db')) as unknown as {
		syntheticTx: unknown
	}
	m.transaction.mockImplementation(
		async (run: (tx: unknown) => Promise<unknown>) => {
			if (m.deadlocks-- > 0)
				throw Object.assign(new Error('deadlock; transaction rolled back'), {
					errno: 1213,
				})
			return run(syntheticTx)
		},
	)
})

describe('actual owner-stop receipt writer', () => {
	it('atomically records rejection and typed proof without changing first body, clocks or neighboring members', async () => {
		const { input } = fixture()
		const before = structuredClone(m.row)
		expect(await recordOwnerStopRejectionLive(input)).toBe('rejected')
		expect(m.updates).toHaveLength(1)
		expect(Object.keys(m.updates[0]!).sort()).toEqual(
			[
				'heldContinuation',
				'lastAttemptAt',
				'lastError',
				'lastStatus',
				'status',
			].sort(),
		)
		expect(m.row).toMatchObject({
			status: 'rejected',
			body: before.body,
			firstFailedAt: before.firstFailedAt,
			occurredAt: before.occurredAt,
			attempts: 0,
			lastError: OWNER_STOP_REJECTED_DIAGNOSTIC,
			lastStatus: 409,
		})
		const state = readHeldContinuationEnvelope(m.row.heldContinuation)!
		expect(state.continuation).toEqual(before.heldContinuation.continuation)
		expect(state.replayProof).toEqual(before.heldContinuation.replayProof)
		expect(state.ownerStopRejection).toMatchObject({
			v: 1,
			scope: { key: before.dedupeKey },
			rejectionCode: 'cold-start-never-born',
			rejectedAttempt: input.rejectedAttempt,
			decidedAt: input.decidedAt,
		})
	})
	it('missing column refuses before capture or any diagnostic fallback', async () => {
		m.missingColumn = true
		await expect(recordOwnerStopRejectionLive(fixture().input)).rejects.toThrow(
			'the heldContinuation column is missing',
		)
		expect(m.capture).not.toHaveBeenCalled()
		expect(m.transaction).not.toHaveBeenCalled()
		expect(m.updates).toHaveLength(0)
		expect(m.row.status).toBe('pending')
	})
	it('does not touch delivered wire history', async () => {
		m.row.status = 'delivered'
		const before = structuredClone(m.row)
		expect(await recordOwnerStopRejectionLive(fixture().input)).toBe(
			'prior-delivered',
		)
		expect(m.row).toEqual(before)
		expect(m.updates).toHaveLength(0)
	})
	it.each(['held', 'superseded'])(
		'refuses a concurrent %s disposition',
		async (status) => {
			m.row.status = status
			await expect(
				recordOwnerStopRejectionLive(fixture().input),
			).rejects.toThrow('concurrent held or closed disposition')
			expect(m.updates).toHaveLength(0)
		},
	)
	it('refuses malformed existing control state instead of overwriting it', async () => {
		m.row.heldContinuation = { v: 2 }
		await expect(recordOwnerStopRejectionLive(fixture().input)).rejects.toThrow(
			'OutboxControl:',
		)
		expect(m.updates).toHaveLength(0)
	})
	it('refuses a different first-owned body identity', async () => {
		m.row.body = { ...m.row.body, contactId: 'another-contact' }
		await expect(recordOwnerStopRejectionLive(fixture().input)).rejects.toThrow(
			'body-mismatch',
		)
		expect(m.updates).toHaveLength(0)
	})
	it('does not treat a lookalike error message as a coded POST answer', async () => {
		const input = fixture().input
		input.problem = {
			title: 'cold-start-never-born',
			detail: 'contact-never-born',
		}
		await expect(recordOwnerStopRejectionLive(input)).rejects.toThrow(
			'not a coded never-born',
		)
		expect(m.capture).not.toHaveBeenCalled()
		expect(m.updates).toHaveLength(0)
	})
	it('fails closed on an unavailable immutable capture', async () => {
		m.capture.mockResolvedValue({ status: 'unavailable' })
		await expect(recordOwnerStopRejectionLive(fixture().input)).rejects.toThrow(
			'immutable first-body ownership is unavailable',
		)
		expect(m.transaction).not.toHaveBeenCalled()
		expect(m.updates).toHaveLength(0)
	})
	it('bounded rolled-back deadlock retries repeat only the transaction, not capture or HTTP', async () => {
		m.deadlocks = 2
		expect(await recordOwnerStopRejectionLive(fixture().input)).toBe('rejected')
		expect(m.capture).toHaveBeenCalledOnce()
		expect(m.transaction).toHaveBeenCalledTimes(3)
		expect(m.updates).toHaveLength(1)
	})
})
