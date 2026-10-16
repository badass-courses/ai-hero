import { describe, expect, it, vi } from 'vitest'
import {
	decodeHeldBatchContinuation,
	encodeHeldBatchContinuation,
	HELD_BATCH_PIN_MAX_AGE_MS,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import {
	HELD_BATCH_RELEASE_CONFIRMATION,
	planHeldBatchRelease,
} from './contact-sync-held-batch-release'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { supersededUnsubscribeReason } from './drovr-unsubscribe-supersession'

const clock = '2032-01-01T00:00:00.000Z'
const id = '00000000-0000-4000-8000-000000000001'
function fixture() {
	const event: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-release-contact',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: clock,
		idempotencyKey: 'synthetic-release-profile:3',
		payload: {
			profileVersion: 3,
			email: 'learner@example.test',
			firstName: null,
			holds: [],
		},
	}
	const entry = outboxEntryForEvent(event, 'bulkDelta')
	const key = drovrOutboxDedupeKey('synthetic-release-target', entry)
	const root: HeldBatchContinuation = {
		v: 1,
		target: 'synthetic-release-target',
		anchorKey: key,
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: { state: 'unfinished' },
		attempt: 2,
		rejectedCarry: 0,
		release: { state: 'held' },
		acknowledge: { contactId: event.contactId, profileVersion: 3 },
		members: [{ key, phase: 'pending', reason: 'event-not-live' }],
	}
	const row: DrovrOutboxRow = {
		...entry,
		id: 'synthetic-release-row',
		target: root.target,
		dedupeKey: key,
		status: 'held',
		attempts: 0,
		lastStatus: 503,
		lastError: 'synthetic original diagnostic',
		firstFailedAt: clock,
		nextAttemptAt: clock,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: clock,
		heldBatch: encodeHeldBatchContinuation(root),
		heldBatchBlocked: true,
	}
	const rows = vi.fn(async () => [row])
	return {
		root,
		row,
		rows,
		args: {
			row,
			rows,
			expectedEncoded: row.heldBatch as string,
			confirmation: HELD_BATCH_RELEASE_CONFIRMATION,
			releaseId: id,
			now: Date.parse(clock),
		},
	}
}

describe('explicit held release preflight', () => {
	it('is read-only and preserves every original scope/clock/byte while proposing a unique permission', async () => {
		const { row, args } = fixture()
		const before = JSON.stringify(row)
		const plan = await planHeldBatchRelease(args)
		const proposed = decodeHeldBatchContinuation(plan.encoded)
		expect(proposed).toEqual({
			...decodeHeldBatchContinuation(args.expectedEncoded),
			release: { state: 'released', id },
		})
		expect(plan.request.data).toMatchObject({
			items: [{ event: row.body }],
			firstFailedAt: clock,
			acknowledge: { profileVersion: 3 },
			heldBatchRelease: { anchorKey: row.dedupeKey, id },
		})
		expect(JSON.stringify(row)).toBe(before)
	})
	it('requires explicit confirmation before loading member bodies', async () => {
		const { args, rows } = fixture()
		await expect(
			planHeldBatchRelease({ ...args, confirmation: '' }),
		).rejects.toThrow(/operator confirmation/)
		expect(rows).not.toHaveBeenCalled()
	})
	it('a stale inspected value cannot authorize a newer permission', async () => {
		const { args, rows } = fixture()
		await expect(
			planHeldBatchRelease({ ...args, expectedEncoded: '{}' }),
		).rejects.toThrow(/encoded state changed/)
		expect(rows).not.toHaveBeenCalled()
	})
	it('requires actual first-body contact/version evidence, not the proposed ACK number', async () => {
		const { args, row, rows } = fixture()
		rows.mockResolvedValue([
			{
				...row,
				body: {
					...(row.body as DrovrShadowEvent),
					payload: {
						profileVersion: 4,
						email: 'learner@example.test',
						firstName: null,
						holds: [],
					},
				},
			},
		])
		await expect(planHeldBatchRelease(args)).rejects.toThrow(
			/first stored authority contact\/version/,
		)
		expect(row.status).toBe('held')
	})
	it('may release an existing coordinator on a delivered carrier without reviving its wire row', async () => {
		const { args, row } = fixture()
		row.status = 'delivered'
		row.deliveredAt = clock
		const before = JSON.stringify(row)
		expect(await planHeldBatchRelease(args)).toMatchObject({
			request: { data: { items: [{ event: row.body }] } },
		})
		expect(JSON.stringify(row)).toBe(before)
	})
	it('may release a retained U0 coordinator without reviving its superseded unsubscribe', async () => {
		const { args, row, root } = fixture()
		row.eventType = 'contact.unsubscribed'
		row.body = {
			...(row.body as DrovrShadowEvent),
			type: 'contact.unsubscribed',
			payload: undefined,
		}
		row.status = 'superseded'
		row.lastError = supersededUnsubscribeReason('2032-01-01T00:00:01.000Z')
		const { buildUnsubscribeSupersession } =
			await import('./drovr-unsubscribe-supersession-proof')
		const proof = buildUnsubscribeSupersession(
			row,
			'2032-01-01T00:00:01.000Z',
			'2032-01-01T00:00:02.000Z',
		)
		row.heldBatch = encodeHeldBatchContinuation({
			...root,
			acknowledge: undefined,
		})
		row.heldContinuation = {
			v: 1,
			continuation: { v: 1, encoded: row.heldBatch, blocked: true },
			unsubscribeSupersession: proof,
		}
		const before = JSON.stringify(row)
		expect(
			await planHeldBatchRelease({
				...args,
				expectedEncoded: row.heldBatch as string,
			}),
		).toMatchObject({ request: { data: { items: [{ event: row.body }] } } })
		expect(JSON.stringify(row)).toBe(before)
	})
	it('shows pin-expired without rebasing the hold or original dispatch clock', async () => {
		const { args } = fixture()
		const plan = await planHeldBatchRelease({
			...args,
			now: Date.parse(clock) + HELD_BATCH_PIN_MAX_AGE_MS,
		})
		expect(plan.pinState).toBe('pin-expired')
		expect(decodeHeldBatchContinuation(plan.encoded)).toMatchObject({
			parkedAt: clock,
			originalClock: clock,
		})
	})
	it('does not revive completed or already released coordinators', async () => {
		const { args, root, row, rows } = fixture()
		for (const value of [
			{
				...root,
				completion: { state: 'completed', at: clock, reason: 'abandoned' },
			},
			{ ...root, release: { state: 'released', id } },
		]) {
			row.heldBatch = encodeHeldBatchContinuation(value)
			row.heldBatchBlocked = false
			row.status = 'delivered'
			await expect(
				planHeldBatchRelease({
					...args,
					expectedEncoded: row.heldBatch as string,
				}),
			).rejects.toThrow(/completed|already released/)
		}
		expect(rows).not.toHaveBeenCalled()
	})
})
