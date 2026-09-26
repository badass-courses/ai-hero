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

type Rotation = { contactId: string; at: string }

function ports(
	fixture: {
		watermark?: string | undefined
		events?: ScannedContactEvent[]
		rotations?: Rotation[]
	} = {},
	overrides: Partial<ContactSyncReconcilePorts> = {},
): ContactSyncReconcilePorts & { order: string[] } {
	const order: string[] = []
	const events = fixture.events ?? [
		event('c1', '2026-09-26T17:41:00.000Z'),
		event('c2', '2026-09-26T17:50:00.000Z'),
		event('c1', '2026-09-26T17:55:00.000Z'),
		event('c9', '2026-09-26T17:20:00.000Z'), // inside the overlap
	]
	const rotations = fixture.rotations ?? [
		{ contactId: 'c3', at: '2026-09-26T17:45:00.000Z' },
	]
	const within = (at: string, after: string, through: string) =>
		Date.parse(at) > Date.parse(after) && Date.parse(at) <= Date.parse(through)
	return {
		order,
		now: () => start,
		readWatermark: vi.fn(async () =>
			'watermark' in fixture ? fixture.watermark : '2026-09-26T17:40:00.000Z',
		),
		scanChanges: vi.fn(async ({ after, through, limit }) =>
			events
				.filter((row) => within(row.occurredAt, after, through))
				.sort(
					(l, r) =>
						Date.parse(l.occurredAt) - Date.parse(r.occurredAt) ||
						l.id.localeCompare(r.id),
				)
				.slice(0, limit + 1),
		),
		// The store's contract: at most limit + 1, extended to the end of a
		// tie at the boundary.
		rotatedContacts: vi.fn(async ({ after, through, limit }) => {
			const ordered = rotations
				.filter((row) => within(row.at, after, through))
				.sort((l, r) => Date.parse(l.at) - Date.parse(r.at))
			let end = Math.min(ordered.length, limit + 1)
			while (end < ordered.length && ordered[end]!.at === ordered[end - 1]!.at)
				end += 1
			return ordered.slice(0, end)
		}),
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
	it('scans fresh changes and the late writes behind the watermark separately', async () => {
		const p = ports()
		await runContactSyncReconcile(p)
		expect(p.scanChanges).toHaveBeenNthCalledWith(1, {
			scope: 'fresh',
			after: '2026-09-26T17:40:00.000Z',
			through,
			limit: 5000,
		})
		// The overlap looks only for rows written after the watermark: late
		// writes under an old occurredAt, not rows already claimed. It reaches
		// 48 h back (prod, 7 days to 2026-09-26: 335 of 2195 signups written
		// over an hour late, none over a day).
		expect(p.scanChanges).toHaveBeenNthCalledWith(2, {
			scope: 'overlap',
			after: '2026-09-24T17:40:00.000Z',
			through: '2026-09-26T17:40:00.000Z',
			writtenAfter: '2026-09-26T17:40:00.000Z',
			limit: 5000,
		})
		expect(p.rotatedContacts).toHaveBeenCalledWith({
			after: '2026-09-26T17:40:00.000Z',
			through,
			limit: 400,
		})
	})

	it('starts an hour back on its first run, with nothing to overlap', async () => {
		const p = ports({ watermark: undefined })
		await runContactSyncReconcile(p)
		expect(p.scanChanges).toHaveBeenCalledTimes(1)
		expect(p.scanChanges).toHaveBeenCalledWith({
			scope: 'fresh',
			after: '2026-09-26T16:58:00.000Z',
			through,
			limit: 5000,
		})
	})

	it('syncs late writes, then fresh and rotated contacts, then stops, heartbeat, watermark', async () => {
		const p = ports()
		const receipt = await runContactSyncReconcile(p)
		expect(p.order).toEqual([
			'sync:c9',
			'sync:c1',
			'sync:c3',
			'sync:c2',
			'stops',
			`heartbeat:${through}`,
			`watermark:${through}`,
		])
		expect(receipt).toEqual({
			status: 'synced',
			syncedThrough: through,
			contacts: 4,
			rotated: 1,
			events: 4,
		})
	})

	it('neither heartbeats nor advances when any push fails', async () => {
		for (const failing of ['sync', 'stops', 'heartbeat'] as const) {
			const boom = async () => {
				throw new Error('drovr 503')
			}
			const p = ports(
				{},
				failing === 'sync'
					? {
							syncContact: vi.fn(async (contactId: string) => {
								if (contactId === 'c2') throw new Error('drovr 503')
								return 'sent' as const
							}),
						}
					: failing === 'stops'
						? { resendStops: vi.fn(boom) }
						: { heartbeat: vi.fn(boom) },
			)
			await expect(runContactSyncReconcile(p)).rejects.toThrow('drovr 503')
			expect(p.writeWatermark).not.toHaveBeenCalled()
			if (failing !== 'heartbeat') expect(p.heartbeat).not.toHaveBeenCalled()
		}
	})

	it('re-sends the stop events of every contact it synced, fresh or overlap', async () => {
		const fresh = event(
			'c2',
			'2026-09-26T17:50:00.000Z',
			'u1',
			'contact.unsubscribed',
		)
		const late = event(
			'c9',
			'2026-09-26T17:20:00.000Z',
			'u2',
			'contact.unsubscribed',
		)
		const p = ports({
			events: [event('c1', '2026-09-26T17:41:00.000Z'), fresh, late],
			rotations: [],
		})
		await runContactSyncReconcile(p)
		expect(p.resendStops).toHaveBeenCalledWith([fresh, late])
	})

	it('claims only what an overflowing fresh scan covered, stopping short of the split second', async () => {
		const p = ports({
			events: [
				event('c1', '2026-09-26T17:41:00.000Z'),
				event('c2', '2026-09-26T17:42:00.000Z'),
				event('c3', '2026-09-26T17:43:05.000Z'),
			],
			rotations: [],
		})
		const receipt = await runContactSyncReconcile(p, { limit: 2 })
		expect(receipt).toMatchObject({
			syncedThrough: '2026-09-26T17:43:04.999Z',
			contacts: 2,
			events: 2,
		})
		expect(p.syncContact).not.toHaveBeenCalledWith('c3')
	})

	it('caps rotation too: an overflowing rotation claims only up to the first one left out', async () => {
		const p = ports({
			events: [],
			rotations: [
				{ contactId: 'r1', at: '2026-09-26T17:41:00.000Z' },
				{ contactId: 'r2', at: '2026-09-26T17:42:00.000Z' },
				{ contactId: 'r3', at: '2026-09-26T17:43:00.500Z' },
			],
		})
		const receipt = await runContactSyncReconcile(p, { maxContacts: 2 })
		expect(receipt).toMatchObject({
			syncedThrough: '2026-09-26T17:43:00.499Z',
			contacts: 2,
			rotated: 2,
		})
		expect(p.syncContact).not.toHaveBeenCalledWith('r3')
	})

	it('caps fresh and rotated contacts together, in time order', async () => {
		const p = ports({
			events: [
				event('c1', '2026-09-26T17:41:00.000Z'),
				event('c2', '2026-09-26T17:44:10.000Z'),
			],
			rotations: [{ contactId: 'r1', at: '2026-09-26T17:42:00.000Z' }],
		})
		const receipt = await runContactSyncReconcile(p, { maxContacts: 2 })
		expect(receipt).toMatchObject({
			syncedThrough: '2026-09-26T17:44:09.999Z',
			contacts: 2,
		})
		expect(p.syncContact).not.toHaveBeenCalledWith('c2')
	})

	it('always syncs every late write, reserving its budget before fresh changes', async () => {
		const late = [
			event('o1', '2026-09-26T17:10:00.000Z'),
			event('o2', '2026-09-26T17:20:00.000Z'),
		]
		const p = ports(
			{ rotations: [] },
			{
				scanChanges: vi.fn(async ({ scope }) =>
					scope === 'overlap'
						? late
						: [
								event('c1', '2026-09-26T17:41:00.000Z'),
								event('c2', '2026-09-26T17:44:10.000Z'),
							],
				),
			},
		)
		const receipt = await runContactSyncReconcile(p, { maxContacts: 3 })
		// Two late writes take two of three slots; fresh gets the third.
		expect(p.syncContact).toHaveBeenCalledWith('o1')
		expect(p.syncContact).toHaveBeenCalledWith('o2')
		expect(p.syncContact).toHaveBeenCalledWith('c1')
		expect(p.syncContact).not.toHaveBeenCalledWith('c2')
		expect(receipt).toMatchObject({
			syncedThrough: '2026-09-26T17:44:09.999Z',
			contacts: 3,
		})
	})

	it('never advances past late writes it could not cover', async () => {
		const p = ports(
			{ rotations: [] },
			{
				scanChanges: vi.fn(async ({ scope }) =>
					scope === 'overlap'
						? [
								event('o1', '2026-09-26T17:10:00.000Z'),
								event('o2', '2026-09-26T17:11:00.000Z'),
								event('o3', '2026-09-26T17:12:00.000Z'),
							]
						: [],
				),
			},
		)
		await expect(runContactSyncReconcile(p, { limit: 2 })).rejects.toThrow(
			/late writes/,
		)
		expect(p.heartbeat).not.toHaveBeenCalled()
		expect(p.writeWatermark).not.toHaveBeenCalled()
	})

	it('takes a whole tie of rotations sharing one instant, past the soft cap, and claims that instant', async () => {
		const at = '2026-09-26T17:41:00.123Z'
		const p = ports({
			events: [],
			rotations: [
				{ contactId: 'r1', at },
				{ contactId: 'r2', at },
				{ contactId: 'r3', at },
			],
		})
		const receipt = await runContactSyncReconcile(p, { maxContacts: 2 })
		// The store returns ties whole; cutting inside one would stall forever.
		expect(receipt).toMatchObject({
			syncedThrough: at,
			contacts: 3,
			rotated: 3,
		})
		for (const contactId of ['r1', 'r2', 'r3'])
			expect(p.syncContact).toHaveBeenCalledWith(contactId)
	})

	it('takes a tie at the contact cap, then cuts before the next instant', async () => {
		const p = ports({
			events: [
				event('c1', '2026-09-26T17:41:00.000Z'),
				event('c2', '2026-09-26T17:41:00.000Z'),
				event('c3', '2026-09-26T17:42:00.000Z'),
			],
			rotations: [],
		})
		const receipt = await runContactSyncReconcile(p, { maxContacts: 1 })
		expect(receipt).toMatchObject({
			syncedThrough: '2026-09-26T17:41:59.999Z',
			contacts: 2,
		})
		expect(p.syncContact).not.toHaveBeenCalledWith('c3')
	})

	it('throws, rather than stall silently, when one instant holds more contacts than the hard ceiling', async () => {
		const at = '2026-09-26T17:41:00.123Z'
		const p = ports({
			events: [],
			rotations: ['r1', 'r2', 'r3', 'r4'].map((contactId) => ({
				contactId,
				at,
			})),
		})
		await expect(
			runContactSyncReconcile(p, { maxContacts: 2, maxContactsHard: 3 }),
		).rejects.toThrow(/one instant/)
		expect(p.heartbeat).not.toHaveBeenCalled()
	})

	it('fails loudly when fresh changes cannot move past the watermark', async () => {
		// Over the limit inside the very first second after the watermark:
		// the claim would not move, so the run must say so, not spin.
		const second = '2026-09-26T17:41:00.000Z'
		const p = ports({
			watermark: '2026-09-26T17:40:59.999Z',
			events: [event('c1', second), event('c2', second), event('c3', second)],
			rotations: [],
		})
		await expect(runContactSyncReconcile(p, { limit: 2 })).rejects.toThrow(
			/cannot advance/,
		)
		expect(p.heartbeat).not.toHaveBeenCalled()
	})

	it('treats a skipped contact (missing, synthetic) as done', async () => {
		const p = ports(
			{},
			{
				syncContact: vi.fn(async (contactId: string) =>
					contactId === 'c2' ? ('skipped' as const) : ('sent' as const),
				),
			},
		)
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
			'drovr-rejected',
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
