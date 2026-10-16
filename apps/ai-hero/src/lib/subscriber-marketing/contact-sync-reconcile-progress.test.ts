import { expect, it, vi } from 'vitest'
import {
	runContactSyncReconcile,
	type ContactSyncReconcilePorts,
	type ReconcileProgress,
	type ScannedContactEvent,
} from './contact-sync-reconcile'
const base = '2032-01-01T09:00:00.000Z'
const at = '2032-01-01T09:30:00.000Z'
const row = (
	index: number,
	suffix: string,
	eventType: string,
	occurredAt = at,
) => ({
	id: `${String(index).padStart(4, '0')}:${suffix}`,
	contactId: `synthetic-${index}`,
	eventType,
	occurredAt,
})
function fixture(rows: (ScannedContactEvent & { writtenAt?: string })[]) {
	let watermark = base
	let progress: ReconcileProgress | undefined
	const p: ContactSyncReconcilePorts = {
		now: () => new Date('2032-01-01T11:00:00.000Z'),
		readWatermark: async () => watermark,
		readProgress: async () => progress,
		scanChanges: async (args) =>
			rows
				.filter(
					(row) =>
						row.occurredAt > args.after &&
						row.occurredAt <= args.through &&
						(!args.writtenAfter ||
							(row.writtenAt ?? row.occurredAt) >= args.writtenAfter) &&
						(!args.writtenThrough ||
							(row.writtenAt ?? row.occurredAt) <= args.writtenThrough) &&
						(!args.pageAfter ||
							row.occurredAt > args.pageAfter.at ||
							(row.occurredAt === args.pageAfter.at &&
								row.id > args.pageAfter.id)),
				)
				.sort((a, b) =>
					a.occurredAt < b.occurredAt
						? -1
						: a.occurredAt > b.occurredAt
							? 1
							: a.id < b.id
								? -1
								: a.id > b.id
									? 1
									: 0,
				)
				.slice(0, args.limit + 1),
		rotatedContacts: async () => [],
		syncContact: vi.fn(async () => 'sent' as const),
		syncOffer: vi.fn(async () => 'sent' as const),
		resendStops: vi.fn(async () => {}),
		heartbeat: vi.fn(async () => {}),
		writeWatermark: async (next, cursor) => {
			watermark = next
			progress = cursor ? structuredClone(cursor) : undefined
		},
	}
	return {
		p,
		get progress() {
			return progress
		},
		get watermark() {
			return watermark
		},
	}
}
it('does not double-count 600 offer-only contacts as 1200 invocations', async () => {
	const h = fixture(
		Array.from({ length: 600 }, (_, index) =>
			row(index, 'offer', 'coupon.issued'),
		),
	)
	const result = await runContactSyncReconcile(h.p)
	expect(result.status).toBe('synced')
	expect(result.contacts).toBe(600)
	expect(h.p.syncOffer).toHaveBeenCalledTimes(600)
	expect(h.p.syncContact).not.toHaveBeenCalled()
	expect(h.watermark).toBe('2032-01-01T10:58:00.000Z')
})
it('resumes a mixed profile/offer timestamp tie through a durable prefix, at most900 invocations per run', async () => {
	const h = fixture(
		Array.from({ length: 700 }, (_, index) => [
			row(index, 'a', 'contact.updated'),
			row(index, 'b', 'coupon.issued'),
		]).flat(),
	)
	const first = await runContactSyncReconcile(h.p, { maxContacts: 900 })
	expect(first.status).toBe('partial')
	expect(h.progress?.after?.id).toBe('0449:b')
	expect(h.watermark).toBe('2032-01-01T09:29:59.999Z')
	expect(h.p.syncContact).toHaveBeenCalledTimes(450)
	expect(h.p.syncOffer).toHaveBeenCalledTimes(450)
	const second = await runContactSyncReconcile(h.p, { maxContacts: 900 })
	expect(second.status).toBe('synced')
	expect(h.progress).toBeUndefined()
	expect(h.p.syncContact).toHaveBeenCalledTimes(700)
	expect(h.p.syncOffer).toHaveBeenCalledTimes(700)
})
it('a first timestamp tie larger than the raw row limit progresses without skipping or throwing', async () => {
	const h = fixture(
		Array.from({ length: 25 }, (_, index) =>
			row(index, 'profile', 'contact.updated'),
		),
	)
	for (let page = 0; page < 5; page++) {
		const result = await runContactSyncReconcile(h.p, { limit: 5 })
		expect(result.status).toBe(page < 4 ? 'partial' : 'synced')
		expect(h.watermark).toBe(
			page < 4 ? '2032-01-01T09:29:59.999Z' : '2032-01-01T10:58:00.000Z',
		)
	}
	expect(h.p.syncContact).toHaveBeenCalledTimes(25)
})
it('late-write overflow also resumes a bounded prefix while keeping the honest timestamp watermark', async () => {
	const h = fixture(
		Array.from({ length: 1000 }, (_, index) => ({
			...row(index, 'late', 'contact.updated', '2032-01-01T08:30:00.000Z'),
			writtenAt: '2032-01-01T10:59:57.000Z',
		})),
	)
	for (let page = 0; page < 2; page++) {
		const result = await runContactSyncReconcile(h.p)
		expect(result.status).toBe(page === 0 ? 'partial' : 'synced')
		expect(h.watermark).toBe(page === 0 ? base : '2032-01-01T10:58:00.000Z')
	}
	expect(h.p.syncContact).toHaveBeenCalledTimes(1000)
})
it('does not lose a deferred result or claim through an offer without a durable coverage receipt', async () => {
	const h = fixture([row(1, 'offer', 'coupon.issued')])
	h.p.syncOffer = vi
		.fn()
		.mockResolvedValueOnce('deferred')
		.mockResolvedValue('sent')
	const first = await runContactSyncReconcile(h.p)
	expect(first.status).toBe('partial')
	expect(first.failed).toEqual(['synthetic-1'])
	expect(h.watermark).toBe('2032-01-01T09:29:59.999Z')
	expect((await runContactSyncReconcile(h.p)).status).toBe('synced')
})
