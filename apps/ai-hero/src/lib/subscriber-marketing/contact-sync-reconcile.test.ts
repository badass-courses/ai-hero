import { describe, expect, it, vi } from 'vitest'

import { captureNormalizedContactEvent } from './capture-contact-event'
import {
	linkRotationRanges,
	reconcileSyncOutcome,
	runContactSyncReconcile,
	stopFactsFor,
	type ContactSyncLateCursor,
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

	it('neither heartbeats nor advances when a late write, the stops or the heartbeat fail', async () => {
		// A late write sits behind the watermark: nothing before it can move.
		for (const failing of ['late-sync', 'stops', 'heartbeat'] as const) {
			const boom = async () => {
				throw new Error('drovr 503')
			}
			const p = ports(
				{},
				failing === 'late-sync'
					? {
							syncContact: vi.fn(async (contactId: string) => {
								if (contactId === 'c9') throw new Error('drovr 503')
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

	it('a failed fresh contact holds the heartbeat at the last instant before its first change (contract §3)', async () => {
		const p = ports(
			{},
			{
				syncContact: vi.fn(async (contactId: string) => {
					if (contactId === 'c2') throw new Error('drovr 503')
					p.order.push(`sync:${contactId}`)
					return 'sent' as const
				}),
			},
		)
		const receipt = await runContactSyncReconcile(p)
		// c2's first change is 17:50:00; everything before it was pushed.
		const held = '2026-09-26T17:49:59.999Z'
		expect(p.order).toEqual([
			'sync:c9',
			'sync:c1',
			'sync:c3',
			'stops',
			`heartbeat:${held}`,
			`watermark:${held}`,
		])
		expect(receipt).toEqual({
			status: 'partial',
			syncedThrough: held,
			contacts: 4,
			rotated: 1,
			events: 4,
			failed: ['c2'],
		})
	})

	it('holds at the earliest first change among several failed contacts', async () => {
		const p = ports(
			{},
			{
				syncContact: vi.fn(async (contactId: string) => {
					if (contactId === 'c2' || contactId === 'c1')
						throw new Error('drovr 503')
					return 'sent' as const
				}),
			},
		)
		const receipt = await runContactSyncReconcile(p)
		// c1 first changed at 17:41:00, before c2 at 17:50.
		expect(receipt).toMatchObject({
			status: 'partial',
			syncedThrough: '2026-09-26T17:40:59.999Z',
			failed: ['c1', 'c2'],
		})
	})

	it('neither heartbeats nor advances when the first failure is at the watermark itself', async () => {
		const p = ports(
			{ events: [event('c1', '2026-09-26T17:40:00.001Z')], rotations: [] },
			{
				syncContact: vi.fn(async () => {
					throw new Error('drovr 503')
				}),
			},
		)
		await expect(runContactSyncReconcile(p)).rejects.toThrow('drovr 503')
		expect(p.heartbeat).not.toHaveBeenCalled()
		expect(p.writeWatermark).not.toHaveBeenCalled()
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

	it("re-sends bounces and complaints too (each writes drovr's suppression row)", async () => {
		const bounce = event(
			'c2',
			'2026-09-26T17:50:00.000Z',
			'b1',
			'contact.bounced',
		)
		const complaint = event(
			'c3',
			'2026-09-26T17:51:00.000Z',
			'k1',
			'contact.complained',
		)
		const p = ports({ events: [bounce, complaint], rotations: [] })
		await runContactSyncReconcile(p)
		expect(p.resendStops).toHaveBeenCalledWith([bounce, complaint])
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

type WrittenEvent = ScannedContactEvent & { createdAt: string }

/**
 * A store that keeps its state across runs: the watermark, the late cursor
 * and the rows, scanned the way the Drizzle store does.
 */
function drainWorld(args: {
	watermark: string
	rows: WrittenEvent[]
	failing?: (contactId: string) => boolean
}) {
	const state = {
		watermark: args.watermark,
		lateCursor: undefined as ContactSyncLateCursor | undefined,
		rows: [...args.rows],
		now: new Date(0),
	}
	const order: string[] = []
	const syncs = new Map<string, number>()
	const skipped = vi.fn(async () => undefined)
	const heartbeat = vi.fn(async () => undefined)
	const resendStops = vi.fn(async (_stops: ScannedContactEvent[]) => undefined)
	const ms = Date.parse
	const ports: ContactSyncReconcilePorts = {
		now: () => state.now,
		readWatermark: async () => state.watermark,
		scanChanges: async ({
			after,
			through,
			writtenAfter,
			limit,
			lateCursor,
		}) => {
			const writtenFrom = writtenAfter
				? Math.floor(ms(writtenAfter) / 1000) * 1000
				: undefined
			const past = lateCursor?.after
			return state.rows
				.filter(
					(row) =>
						ms(row.occurredAt) > ms(after) &&
						ms(row.occurredAt) <= ms(through) &&
						(writtenFrom === undefined || ms(row.createdAt) >= writtenFrom) &&
						(!past ||
							ms(row.createdAt) > ms(past.createdAt) ||
							(ms(row.createdAt) === ms(past.createdAt) && row.id > past.id)),
				)
				.sort((l, r) =>
					lateCursor
						? ms(l.createdAt) - ms(r.createdAt) || l.id.localeCompare(r.id)
						: ms(l.occurredAt) - ms(r.occurredAt) || l.id.localeCompare(r.id),
				)
				.slice(0, limit + 1)
		},
		rotatedContacts: async () => [],
		syncContact: async (contactId: string) => {
			if (args.failing?.(contactId)) throw new Error('drovr 503')
			syncs.set(contactId, (syncs.get(contactId) ?? 0) + 1)
			order.push(`sync:${contactId}`)
			return 'sent' as const
		},
		resendStops,
		heartbeat,
		writeWatermark: async (watermark: string) => {
			state.watermark = watermark
			order.push(`watermark:${watermark}`)
		},
		lateCursor: {
			read: async () => state.lateCursor,
			write: async (cursor) => {
				state.lateCursor = cursor
			},
			skipped,
		},
	}
	// Every 15 minutes, as the cron.
	const run = async (at: string, options = {}) => {
		state.now = new Date(at)
		return runContactSyncReconcile(ports, options)
	}
	return { state, order, syncs, skipped, heartbeat, resendStops, run }
}

const runAt = (run: number) =>
	new Date(
		Date.parse('2026-10-30T08:30:00.000Z') + run * 15 * 60 * 1000,
	).toISOString()

describe('contact sync reconcile drains a late-write backlog', () => {
	// 2026-10-30: the absence-proof write, one occurredAt, written over an
	// hour behind the watermark.
	const watermark = '2026-10-30T07:13:02.343Z'
	const clump = (
		count: number,
		eventType = 'newsletter.old-sequence.exit-confirmed',
	) =>
		Array.from(
			{ length: count },
			(_, index): WrittenEvent => ({
				id: `late-${String(index).padStart(4, '0')}`,
				contactId: `contact-${String(index).padStart(4, '0')}`,
				eventType,
				occurredAt: '2026-10-30T06:45:22.000Z',
				// Some seconds hold two rows, so cursors land inside a second.
				createdAt: new Date(
					Date.parse('2026-10-30T07:19:55.000Z') +
						Math.floor(index * 0.8) * 1000,
				).toISOString(),
			}),
		)
	const freshRow: WrittenEvent = {
		id: 'fresh-1',
		contactId: 'fresh-contact',
		eventType: 'skills-newsletter.subscribed',
		occurredAt: '2026-10-30T07:30:00.000Z',
		createdAt: '2026-10-30T07:30:00.000Z',
	}

	it('drains 3,000 late contacts over 8 runs, then advances and clears the cursor', async () => {
		const world = drainWorld({ watermark, rows: [...clump(3000), freshRow] })
		for (let run = 0; run < 7; run += 1) {
			const receipt = await world.run(runAt(run))
			expect(receipt).toMatchObject({
				status: 'draining',
				syncedThrough: watermark,
				contacts: 400,
				rotated: 0,
			})
			expect(world.state.watermark).toBe(watermark)
			expect(world.state.lateCursor?.after?.id).toBe(
				`late-${String((run + 1) * 400 - 1).padStart(4, '0')}`,
			)
		}
		expect(world.heartbeat).not.toHaveBeenCalled()
		// No fresh contact while draining.
		expect(world.syncs.has('fresh-contact')).toBe(false)

		const last = await world.run(runAt(7))
		const planned = new Date(Date.parse(runAt(7)) - 2 * 60 * 1000).toISOString()
		expect(last).toMatchObject({
			status: 'synced',
			syncedThrough: planned,
			contacts: 201,
		})
		expect(world.state.watermark).toBe(planned)
		expect(world.state.lateCursor).toBeUndefined()
		expect(world.heartbeat).toHaveBeenCalledTimes(1)
		// Each contact once: the cursor kept every drained row out of the scan.
		expect(world.syncs.size).toBe(3001)
		expect([...world.syncs.values()].every((count) => count === 1)).toBe(true)
	})

	it('syncs a late write landing mid-drain before the watermark moves', async () => {
		const world = drainWorld({ watermark, rows: clump(3000) })
		for (let run = 0; run < 3; run += 1) await world.run(runAt(run))
		world.state.rows.push({
			id: 'straggler-1',
			contactId: 'straggler',
			eventType: 'skills-newsletter.subscribed',
			occurredAt: '2026-10-30T07:00:00.000Z',
			createdAt: runAt(3),
		})
		for (let run = 3; run < 8; run += 1) await world.run(runAt(run))
		expect(world.state.watermark).not.toBe(watermark)
		const straggler = world.order.indexOf('sync:straggler')
		const advanced = world.order.findIndex((entry) =>
			entry.startsWith('watermark:'),
		)
		expect(straggler).toBeGreaterThanOrEqual(0)
		expect(straggler).toBeLessThan(advanced)
	})

	it('holds the cursor on a failing contact for 2 runs, skips it on the 3rd, and drains on', async () => {
		const world = drainWorld({
			watermark,
			rows: clump(12),
			failing: (contactId) => contactId === 'contact-0004',
		})
		const options = { maxContacts: 4 }
		await world.run(runAt(0), options)
		expect(world.state.lateCursor).toEqual({
			after: { createdAt: expect.any(String), id: 'late-0003' },
		})
		for (const [run, runs] of [
			[1, 1],
			[2, 2],
		] as const) {
			const receipt = await world.run(runAt(run), options)
			expect(receipt).toMatchObject({
				status: 'draining',
				failed: ['contact-0004'],
			})
			expect(world.state.lateCursor).toEqual({
				after: { createdAt: expect.any(String), id: 'late-0003' },
				failing: { contactId: 'contact-0004', runs },
			})
			expect(world.skipped).not.toHaveBeenCalled()
		}
		const third = await world.run(runAt(3), options)
		expect(third).toMatchObject({
			status: 'draining',
			lateSkipped: ['contact-0004'],
		})
		expect(world.skipped).toHaveBeenCalledTimes(1)
		expect(world.skipped).toHaveBeenCalledWith({
			contactId: 'contact-0004',
			eventType: 'newsletter.old-sequence.exit-confirmed',
			reason: 'sync failed 3 runs in a row',
		})
		expect(world.state.lateCursor).toEqual({
			after: { createdAt: expect.any(String), id: 'late-0007' },
		})
		expect(world.state.watermark).toBe(watermark)

		// Four left fit one run: the normal path takes them and advances.
		await expect(world.run(runAt(4), options)).resolves.toMatchObject({
			status: 'synced',
			contacts: 4,
		})
		expect(world.state.lateCursor).toBeUndefined()
		expect(world.state.watermark).not.toBe(watermark)
		expect(world.skipped).toHaveBeenCalledTimes(1)
	})

	it('re-sends the stops of the late contacts a draining run synced', async () => {
		const world = drainWorld({
			watermark,
			rows: clump(6, 'contact.unsubscribed'),
		})
		const receipt = await world.run(runAt(0), { maxContacts: 4 })
		expect(receipt.status).toBe('draining')
		expect(world.resendStops).toHaveBeenCalledWith(
			clump(4, 'contact.unsubscribed'),
		)
	})

	it('drains no row written inside the settle window', async () => {
		const world = drainWorld({ watermark, rows: clump(6) })
		// Rows 3 onward land inside the run's two-minute settle.
		const at = new Date(
			Date.parse(world.state.rows[3]!.createdAt) + 2 * 60 * 1000 - 1,
		).toISOString()
		const receipt = await world.run(at, { maxContacts: 4 })
		expect(receipt).toMatchObject({ status: 'draining', contacts: 3 })
		expect(world.state.lateCursor?.after?.id).toBe('late-0002')
	})

	const stop = (index: number) =>
		clump(index + 1, 'contact.unsubscribed')[index]!
	const subscribed = (index: number) => clump(index + 1)[index]!

	it('sends a late stop before a holding failure moves the cursor past it', async () => {
		// Normal path (two late contacts): the stop row, then one that fails.
		const rows = [stop(0), subscribed(1)]
		const failing = (contactId: string) => contactId === 'contact-0001'

		const refused = drainWorld({ watermark, rows, failing })
		refused.resendStops.mockRejectedValueOnce(new Error('drovr 503 on stops'))
		await expect(refused.run(runAt(0))).rejects.toThrow('drovr 503 on stops')
		// Undelivered: the cursor never moved past it.
		expect(refused.state.lateCursor).toBeUndefined()

		const world = drainWorld({ watermark, rows, failing })
		await expect(world.run(runAt(0))).rejects.toThrow('drovr 503')
		expect(world.resendStops).toHaveBeenCalledWith([stop(0)])
		expect(world.state.lateCursor).toEqual({
			after: { createdAt: stop(0).createdAt, id: 'late-0000' },
			failing: { contactId: 'contact-0001', runs: 1 },
		})
		expect(world.state.watermark).toBe(watermark)
	})

	it('never moves past a skipped contact until its stop went out', async () => {
		const rows = [stop(0), subscribed(1)]
		const world = drainWorld({
			watermark,
			rows,
			failing: (contactId) => contactId === 'contact-0000',
		})
		const held = { failing: { contactId: 'contact-0000', runs: 2 } }
		world.state.lateCursor = held
		world.resendStops.mockRejectedValueOnce(new Error('drovr 503 on stops'))
		await expect(world.run(runAt(0))).rejects.toThrow('drovr 503 on stops')
		expect(world.state.lateCursor).toEqual(held)
		expect(world.skipped).not.toHaveBeenCalled()

		// Next run: the skip goes through, its stop with it, then the advance.
		await expect(world.run(runAt(1))).resolves.toMatchObject({
			status: 'partial',
			lateSkipped: ['contact-0000'],
		})
		expect(world.resendStops).toHaveBeenLastCalledWith([stop(0)])
		expect(world.skipped).toHaveBeenCalledTimes(1)
		expect(world.state.watermark).not.toBe(watermark)
		expect(world.state.lateCursor).toBeUndefined()
	})

	it("re-sends a skipped contact's stops in the draining run that passes them", async () => {
		const world = drainWorld({
			watermark,
			rows: clump(12, 'contact.unsubscribed'),
			failing: (contactId) => contactId === 'contact-0004',
		})
		const options = { maxContacts: 4 }
		for (let run = 0; run < 3; run += 1) await world.run(runAt(run), options)
		expect(world.resendStops).not.toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: 'late-0004' })]),
		)
		await world.run(runAt(3), options)
		expect(world.skipped).toHaveBeenCalledTimes(1)
		expect(world.resendStops.mock.lastCall?.[0].map((row) => row.id)).toEqual([
			'late-0004',
			'late-0005',
			'late-0006',
			'late-0007',
		])
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
		for (const reason of [
			'contact-missing',
			'synthetic-principal',
			// Out of drovr's scope: nothing to push, so the watermark moves.
			'no-sending-journey',
			// drovr ignores a profile without an email; nothing to push.
			'contact-email-missing',
			// Contract §4: a rejection is final for that event, answered.
			'drovr-rejected',
			// Unsubscribed contacts are held, not pushed; no retry chain.
			'unsubscribed-held',
			// Nothing new since the last push.
			'unchanged',
		])
			expect(reconcileSyncOutcome('c1', { status: 'skipped', reason })).toBe(
				'skipped',
			)
		// Contract §3: a refusal as event-not-live does not hold the watermark;
		// the same events are already scheduled for after the straggler pass.
		for (const reason of ['event-not-live', 'cold-start-unhandled'] as const)
			expect(
				reconcileSyncOutcome('c1', {
					status: 'deferred',
					reason,
					profileVersion: 2,
					deferred: 1,
				}),
			).toBe('deferred')
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
