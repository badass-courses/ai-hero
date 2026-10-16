import { describe, expect, it, vi } from 'vitest'
import {
	abandonHeldBatch,
	completeHeldBatch,
	HELD_BATCH_ABANDON_CONFIRMATION,
} from './contact-sync-held-batch-completion'
import {
	decodeHeldBatchContinuation,
	encodeHeldBatchContinuation,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import { collectHeldBatchPins } from './contact-sync-held-batch-pins'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const clock = '2032-01-01T00:00:00.000Z'
const id = '00000000-0000-4000-8000-000000000001'
function fixture() {
	const event: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-completion-contact',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: clock,
		idempotencyKey: 'synthetic-completion-profile:3',
		payload: {
			profileVersion: 3,
			email: 'learner@example.test',
			firstName: null,
			holds: [],
		},
	}
	const entry = outboxEntryForEvent(event, 'bulkDelta')
	const target = 'synthetic-completion-target'
	const key = drovrOutboxDedupeKey(target, entry)
	const root: HeldBatchContinuation = {
		v: 1,
		target,
		anchorKey: key,
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: { state: 'unfinished' },
		attempt: 2,
		rejectedCarry: 0,
		release: { state: 'released', id },
		acknowledge: { contactId: event.contactId, profileVersion: 3 },
		members: [{ key, phase: 'pending', reason: 'event-not-live' }],
	}
	const row: DrovrOutboxRow = {
		...entry,
		id: 'synthetic-completion-row',
		target,
		dedupeKey: key,
		status: 'delivered',
		attempts: 1,
		lastStatus: 202,
		lastError: null,
		firstFailedAt: clock,
		nextAttemptAt: clock,
		lastAttemptAt: clock,
		deliveredAt: clock,
		releasedAt: null,
		createdAt: clock,
		heldBatch: encodeHeldBatchContinuation(root),
		heldBatchBlocked: false,
	}
	const store = {
		read: vi.fn(async () => ({ encoded: row.heldBatch })),
		block: vi.fn(async () => true),
		finish: vi.fn(async (args: { previous: string; encoded: string }) => {
			if (row.heldBatch !== args.previous) return false
			row.heldBatch = args.encoded
			return true
		}),
	}
	const rows = vi.fn(async () => [row])
	const anchor = { target, key }
	return {
		root,
		row,
		store,
		rows,
		anchor,
		args: { anchor, releaseId: id, at: clock, store, rows },
	}
}

describe('terminal logical completion markers', () => {
	it('ends the reference pin without rewriting the accepted wire receipt, body or clocks', async () => {
		const { row, args } = fixture()
		const { heldBatch: _beforeMetadata, ...before } = row
		await expect(completeHeldBatch(args)).resolves.toEqual({
			status: 'completed',
			reason: 'delivered',
		})
		const { heldBatch, ...after } = row
		expect(after).toEqual(before)
		expect(decodeHeldBatchContinuation(heldBatch as string).completion).toEqual(
			{ state: 'completed', at: clock, reason: 'delivered' },
		)
		expect(
			collectHeldBatchPins(
				[{ ...args.anchor, encoded: heldBatch }],
				Date.parse(clock),
			).pinned.size,
		).toBe(0)
	})
	it.each(['pending', 'deferred', 'held'] as const)(
		'cannot complete a logical member still %s',
		async (status) => {
			const { row, args, store } = fixture()
			row.status = status
			await expect(completeHeldBatch(args)).rejects.toThrow(
				/HeldBatchContinuation:/,
			)
			expect(store.finish).not.toHaveBeenCalled()
			expect(
				decodeHeldBatchContinuation(row.heldBatch as string).completion.state,
			).toBe('unfinished')
		},
	)
	it('terminal rejection ends logical work without declaring receiver acceptance or changing the rejection', async () => {
		const { row, args } = fixture()
		row.status = 'rejected'
		row.lastStatus = 409
		row.deliveredAt = null
		await expect(completeHeldBatch(args)).resolves.toEqual({
			status: 'completed',
			reason: 'terminal-rejected',
		})
		expect(row.status).toBe('rejected')
		expect(row.lastStatus).toBe(409)
		expect(row.deliveredAt).toBeNull()
	})
	it('refuses a stale release ID and lost completion CAS', async () => {
		const { args, store } = fixture()
		await expect(
			completeHeldBatch({
				...args,
				releaseId: '00000000-0000-4000-8000-000000000002',
			}),
		).rejects.toThrow(/newer held\/released permission/)
		store.finish.mockResolvedValue(false)
		await expect(completeHeldBatch(args)).rejects.toThrow(
			/newer permission or completion/,
		)
	})
	it('abandonment requires explicit cancellation confirmation and only completes coordinator metadata', async () => {
		const { row, args, store } = fixture()
		row.status = 'held'
		row.lastStatus = 503
		row.deliveredAt = null
		const expectedEncoded = row.heldBatch as string
		await expect(
			abandonHeldBatch({ ...args, expectedEncoded, confirmation: '' }),
		).rejects.toThrow(/cancelling and saving/)
		expect(store.finish).not.toHaveBeenCalled()
		const { heldBatch: _metadata, ...nativeBefore } = row
		await expect(
			abandonHeldBatch({
				...args,
				expectedEncoded,
				confirmation: HELD_BATCH_ABANDON_CONFIRMATION,
			}),
		).resolves.toEqual({ status: 'completed', reason: 'abandoned' })
		const { heldBatch, ...nativeAfter } = row
		expect(nativeAfter).toEqual(nativeBefore)
		expect(
			decodeHeldBatchContinuation(heldBatch as string).completion,
		).toMatchObject({ reason: 'abandoned' })
	})
	it('a stale abandonment cannot overwrite a changed encoded permission', async () => {
		const { args, store } = fixture()
		await expect(
			abandonHeldBatch({
				...args,
				expectedEncoded: '{}',
				confirmation: HELD_BATCH_ABANDON_CONFIRMATION,
			}),
		).rejects.toThrow(/inspected permission changed/)
		expect(store.finish).not.toHaveBeenCalled()
	})
	it('completion is idempotent and cannot convert abandonment into acceptance', async () => {
		const { row, args } = fixture()
		await abandonHeldBatch({
			...args,
			expectedEncoded: row.heldBatch as string,
			confirmation: HELD_BATCH_ABANDON_CONFIRMATION,
		})
		await expect(completeHeldBatch(args)).resolves.toEqual({
			status: 'already-completed',
		})
		expect(
			decodeHeldBatchContinuation(row.heldBatch as string).completion,
		).toMatchObject({ reason: 'abandoned' })
	})
})
