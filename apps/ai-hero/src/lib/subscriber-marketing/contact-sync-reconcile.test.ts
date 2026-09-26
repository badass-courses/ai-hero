import { describe, expect, it, vi } from 'vitest'

import { captureNormalizedContactEvent } from './capture-contact-event'
import {
	linkRotationRanges,
	reconcileSyncOutcome,
	runContactSyncReconcile,
	stopFactsFor,
	type ContactSyncReconcilePorts,
	type ScannedContactEvent,
} from './contact-sync-reconcile'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'
import { normalizeContactEvent } from './normalize-contact-event'

const start = new Date('2026-09-26T18:00:00.000Z')
const through = '2026-09-26T17:58:00.000Z' // start − 2 min

function event(
	contactId: string,
	occurredAt: string,
	id = `${contactId}:${occurredAt}`,
	eventType = 'skills-newsletter.subscribed',
): ScannedContactEvent {
	return { id, contactId, occurredAt, eventType }
}

function ports(
	overrides: Partial<ContactSyncReconcilePorts> = {},
): ContactSyncReconcilePorts & { order: string[] } {
	const order: string[] = []
	return {
		order,
		now: () => start,
		readWatermark: vi.fn(async () => '2026-09-26T17:40:00.000Z'),
		scanChanges: vi.fn(async () => [
			event('c1', '2026-09-26T17:41:00.000Z'),
			event('c2', '2026-09-26T17:50:00.000Z'),
			event('c1', '2026-09-26T17:55:00.000Z'),
		]),
		rotatedContacts: vi.fn(async () => ['c3']),
		syncContact: vi.fn(async (contactId: string) => {
			order.push(`sync:${contactId}`)
			return 'sent' as const
		}),
		resendStops: vi.fn(async () => {
			order.push('stops')
		}),
		heartbeat: vi.fn(async (syncedThrough: string) => {
			order.push(`heartbeat:${syncedThrough}`)
		}),
		writeWatermark: vi.fn(async (watermark: string) => {
			order.push(`watermark:${watermark}`)
		}),
		...overrides,
	}
}

describe('contact sync reconcile', () => {
	it('scans from the watermark less a 1 h overlap up to start − 2 min', async () => {
		const p = ports()
		await runContactSyncReconcile(p)
		expect(p.scanChanges).toHaveBeenCalledWith({
			after: '2026-09-26T16:40:00.000Z',
			through,
			limit: 5000,
		})
	})

	it('starts an hour back on its first run', async () => {
		const p = ports({ readWatermark: vi.fn(async () => undefined) })
		await runContactSyncReconcile(p)
		expect(p.scanChanges).toHaveBeenCalledWith(
			expect.objectContaining({ after: '2026-09-26T16:58:00.000Z', through }),
		)
		expect(p.rotatedContacts).toHaveBeenCalledWith({
			after: '2026-09-26T16:58:00.000Z',
			through,
		})
	})

	it('syncs each touched contact once, re-sends stops, then heartbeats, then advances', async () => {
		const p = ports()
		const receipt = await runContactSyncReconcile(p)
		expect(p.order).toEqual([
			'sync:c1',
			'sync:c2',
			'sync:c3',
			'stops',
			`heartbeat:${through}`,
			`watermark:${through}`,
		])
		expect(receipt).toEqual({
			status: 'synced',
			syncedThrough: through,
			contacts: 3,
			rotated: 1,
			events: 3,
		})
		// Rotation looks from the last watermark, not the overlap.
		expect(p.rotatedContacts).toHaveBeenCalledWith({
			after: '2026-09-26T17:40:00.000Z',
			through,
		})
	})

	it('neither heartbeats nor advances when any push fails', async () => {
		for (const failing of ['sync', 'stops'] as const) {
			const p = ports(
				failing === 'sync'
					? {
							syncContact: vi.fn(async (contactId: string) => {
								if (contactId === 'c2') throw new Error('drovr 503')
								return 'sent' as const
							}),
						}
					: {
							resendStops: vi.fn(async () => {
								throw new Error('drovr 503')
							}),
						},
			)
			await expect(runContactSyncReconcile(p)).rejects.toThrow('drovr 503')
			expect(p.heartbeat).not.toHaveBeenCalled()
			expect(p.writeWatermark).not.toHaveBeenCalled()
		}
	})

	it('does not advance when the heartbeat fails', async () => {
		const p = ports({
			heartbeat: vi.fn(async () => {
				throw new Error('heartbeat 502')
			}),
		})
		await expect(runContactSyncReconcile(p)).rejects.toThrow('heartbeat 502')
		expect(p.writeWatermark).not.toHaveBeenCalled()
	})

	it('re-sends only the stop events it scanned', async () => {
		const unsubscribe = event(
			'c2',
			'2026-09-26T17:50:00.000Z',
			'e-unsub',
			'contact.unsubscribed',
		)
		const p = ports({
			scanChanges: vi.fn(async () => [
				event('c1', '2026-09-26T17:41:00.000Z'),
				unsubscribe,
			]),
		})
		await runContactSyncReconcile(p)
		expect(p.resendStops).toHaveBeenCalledWith([unsubscribe])
	})

	it('claims only what an overflowing scan covered, stopping short of the split second', async () => {
		const rows = [
			event('c1', '2026-09-26T17:41:00.000Z'),
			event('c2', '2026-09-26T17:42:00.000Z'),
			event('c3', '2026-09-26T17:43:05.000Z'),
		]
		const p = ports({
			scanChanges: vi.fn(async () => rows),
			rotatedContacts: vi.fn(async () => []),
		})
		const receipt = await runContactSyncReconcile(p, { limit: 2 })
		// The third row is past the limit: everything strictly before its
		// second is covered, and the overlap re-scans the rest next run.
		expect(receipt).toMatchObject({
			status: 'synced',
			syncedThrough: '2026-09-26T17:43:04.999Z',
			contacts: 2,
			events: 2,
		})
		expect(p.syncContact).not.toHaveBeenCalledWith('c3')
		expect(p.heartbeat).toHaveBeenCalledWith('2026-09-26T17:43:04.999Z')
		// Rotation is claimed only as far as the watermark goes.
		expect(p.rotatedContacts).toHaveBeenCalledWith({
			after: '2026-09-26T17:40:00.000Z',
			through: '2026-09-26T17:43:04.999Z',
		})
	})

	it('fails loudly when an overflow cannot move past the start', async () => {
		const second = '2026-09-26T16:40:00.000Z'
		const p = ports({
			scanChanges: vi.fn(async () => [
				event('c1', second),
				event('c2', second),
				event('c3', second),
			]),
		})
		await expect(runContactSyncReconcile(p, { limit: 2 })).rejects.toThrow(
			/cannot advance/,
		)
		expect(p.heartbeat).not.toHaveBeenCalled()
	})

	it('caps the contacts one run syncs, claiming only up to the second the next one appears', async () => {
		const p = ports({
			scanChanges: vi.fn(async () => [
				event('c1', '2026-09-26T17:41:00.000Z'),
				event('c1', '2026-09-26T17:42:00.000Z'),
				event('c2', '2026-09-26T17:43:00.000Z'),
				event('c3', '2026-09-26T17:44:10.000Z'),
				event('c1', '2026-09-26T17:45:00.000Z'),
			]),
			rotatedContacts: vi.fn(async () => []),
		})
		const receipt = await runContactSyncReconcile(p, { maxContacts: 2 })
		expect(receipt).toMatchObject({
			syncedThrough: '2026-09-26T17:44:09.999Z',
			contacts: 2,
			events: 3,
		})
		expect(p.syncContact).not.toHaveBeenCalledWith('c3')
	})

	it('treats a skipped contact (missing, synthetic) as done', async () => {
		const p = ports({
			syncContact: vi.fn(async (contactId: string) =>
				contactId === 'c2' ? ('skipped' as const) : ('sent' as const),
			),
		})
		await expect(runContactSyncReconcile(p)).resolves.toMatchObject({
			status: 'synced',
		})
	})
})

describe('link rotation ranges', () => {
	it('selects the first issues whose 90-day step fell inside the window', () => {
		const ranges = linkRotationRanges({
			after: '2026-09-26T17:40:00.000Z',
			through: '2026-09-26T17:58:00.000Z',
		})
		expect(ranges).toHaveLength(5)
		expect(ranges[0]).toEqual({
			after: '2026-06-28T17:40:00.000Z',
			through: '2026-06-28T17:58:00.000Z',
		})
		expect(ranges[1]).toEqual({
			after: '2026-03-30T17:40:00.000Z',
			through: '2026-03-30T17:58:00.000Z',
		})
	})
})

describe('what a profile sync receipt means for the watermark', () => {
	it('counts sent and the benign skips, and refuses everything else', () => {
		expect(
			reconcileSyncOutcome('c1', {
				status: 'sent',
				profileVersion: 3,
				links: 0,
				offers: 0,
				accepted: 1,
				rejected: 0,
			}),
		).toBe('sent')
		for (const reason of ['contact-missing', 'synthetic-principal'])
			expect(reconcileSyncOutcome('c1', { status: 'skipped', reason })).toBe(
				'skipped',
			)
		for (const reason of [
			'drovr-not-configured',
			'AIH_DROVR_PROFILE_SYNC is not set',
		])
			expect(() =>
				reconcileSyncOutcome('c1', { status: 'skipped', reason }),
			).toThrow(`profile sync for c1 was not pushed: ${reason}`)
	})
})

describe('re-sent stops are the live facts, under the same keys', () => {
	it('maps each scanned unsubscribe exactly as the live dispatch does', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await captureNormalizedContactEvent({
			repository,
			event: normalizeContactEvent({
				provider: 'kit',
				providerEventId: 'unsub-1',
				eventType: 'contact.unsubscribed',
				occurredAt: '2026-09-26T17:50:00.000Z',
				email: 'learner@example.test',
				externalId: 'kit-1',
				message: 'Unsubscribed in Kit',
			}),
		})
		const stored = captured.contactEvent
		const facts = await stopFactsFor(repository, [
			{
				id: stored.id,
				contactId: stored.contactId,
				eventType: stored.eventType,
				occurredAt: stored.occurredAt,
			},
		])
		expect(facts).toEqual(
			mapDrovrShadowFact({ kind: 'contact-event', event: stored }),
		)
		expect(facts.length).toBeGreaterThan(0)
		expect(new Set(facts.map((fact) => fact.type))).toEqual(
			new Set(['contact.unsubscribed']),
		)
	})
})
