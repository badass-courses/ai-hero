import { describe, expect, it, vi } from 'vitest'

import {
	DROVR_CONTACT_SYNC_BACKFILL_EVENT,
	DROVR_EVENTS_DELIVER_BULK_EVENT,
} from '@/inngest/events/drovr'

import {
	BACKFILL_STOP_PHASES,
	runContactSyncBackfill,
	runContactSyncBackfillPage,
	type BackfillCursor,
	type BackfillPorts,
	type BackfillRow,
} from './contact-sync-backfill'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import type { ContactProfileSnapshot } from './drovr-contact-profile-sync'
import { DROVR_SKILLS_COURSE_JOURNEY_ID } from './drovr-shadow-emitter'

const frozen = Date.parse('2026-10-01T12:00:00.000Z')

function world(
	fixture: {
		owners?: number
		stops?: Partial<
			Record<(typeof BACKFILL_STOP_PHASES)[number], BackfillRow[]>
		>
		synthetic?: string[]
		/** Owner assignments for a journey outside drovr's sending set. */
		otherJourney?: string[]
		/** Double opt-in signups (skills-newsletter.doi-requested). */
		doubleOptIn?: string[]
		/** Contacts whose snapshot has no email. */
		noEmail?: string[]
	} = {},
) {
	const owners: BackfillRow[] = Array.from(
		{ length: fixture.owners ?? 3 },
		(_, index) => ({
			id: `e${String(index).padStart(5, '0')}`,
			contactId: `c${String(index).padStart(5, '0')}`,
			eventType: 'journey.owner.assigned',
			providerEventId: `drovr-owner:c${String(index).padStart(5, '0')}:value-path-skills-course`,
			occurredAt: `2026-09-2${index % 5}T00:00:00.000Z`,
		}),
	)
		.concat(
			(fixture.synthetic ?? []).map((contactId, index) => ({
				id: `s${index}`,
				contactId,
				eventType: 'journey.owner.assigned',
				providerEventId: `drovr-owner:${contactId}:shadow-newsletter`,
				occurredAt: '2026-09-26T00:00:00.000Z',
			})),
		)
		.concat(
			(fixture.otherJourney ?? []).map((contactId, index) => ({
				id: `o${index}`,
				contactId,
				eventType: 'journey.owner.assigned',
				providerEventId: `drovr-owner:${contactId}:some-retired-journey`,
				occurredAt: '2026-09-26T00:00:00.000Z',
			})),
		)
		.sort(
			(left, right) =>
				Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
				left.id.localeCompare(right.id),
		)
	const stamps: { contactId: string; now: string }[] = []
	const versions = createMemoryContactProfileVersionStore({
		now: () => new Date(frozen).toISOString(),
	})
	const ports: BackfillPorts = {
		// A frozen clock: every call answers the same instant.
		now: () => frozen,
		scanEvents: async ({ eventType, afterOccurredAt, afterId, limit }) => {
			const doubleOptIn = (fixture.doubleOptIn ?? []).map(
				(contactId, index) => ({
					id: `d${index}`,
					contactId,
					eventType: 'skills-newsletter.doi-requested',
					providerEventId: `doi-request:form:${contactId}`,
					occurredAt: '2026-09-26T00:00:00.000Z',
				}),
			)
			const rows =
				eventType === 'journey.owner.assigned'
					? owners
					: eventType === 'skills-newsletter.doi-requested'
						? doubleOptIn
						: (fixture.stops?.[eventType as never] ?? [])
			return rows
				.filter(
					(row) =>
						!afterOccurredAt ||
						Date.parse(row.occurredAt) > Date.parse(afterOccurredAt) ||
						(row.occurredAt === afterOccurredAt && row.id > (afterId ?? '')),
				)
				.slice(0, limit)
		},
		snapshot: async (contactId, now) => {
			stamps.push({ contactId, now })
			return {
				occurredAt: now,
				profile: {
					email: (fixture.noEmail ?? []).includes(contactId)
						? ''
						: `${contactId}@example.test`,
					firstName: null,
					holds: [],
				},
				links: [],
				offers: [],
			} satisfies ContactProfileSnapshot
		},
		versionFor: (contactId, hash) => versions.versionFor(contactId, hash),
		// The live dispatch's facts: stands in for stopFactsFor.
		// Stands in for stopFactsFor: the live mapping's directory stop (every
		// stop type, owned or not), under the live key.
		liveStopFacts: async (rows) =>
			rows.map((row) => ({
				tenantId: 'org-aihero' as const,
				contactId: row.contactId,
				journeyId: 'contact-directory' as const,
				type: row.eventType as 'contact.unsubscribed',
				occurredAt: row.occurredAt,
				idempotencyKey: `live:${row.id}`,
			})),
	}
	return { ports, stamps }
}

async function drain(ports: BackfillPorts, pageSize: number) {
	let cursor: BackfillCursor = { phase: 'owners' }
	const pages: Awaited<ReturnType<typeof runContactSyncBackfillPage>>[] = []
	for (let guard = 0; cursor.phase !== 'done' && guard < 1000; guard += 1) {
		const page = await runContactSyncBackfillPage(ports, cursor, { pageSize })
		pages.push(page)
		cursor = page.next
	}
	return pages
}

describe('contact sync backfill', () => {
	it('stamps every contact with its own instant, even 1000 of them under a frozen clock', async () => {
		// A backfill that stamped a whole batch with one `now` would, 90 days
		// later, rotate a same-instant tie over the reconcile's 900 ceiling.
		const { ports, stamps } = world({ owners: 1000 })
		await drain(ports, 100)
		expect(stamps).toHaveLength(1000)
		const perInstant = new Map<string, number>()
		for (const { now } of stamps)
			perInstant.set(now, (perInstant.get(now) ?? 0) + 1)
		expect(Math.max(...perInstant.values())).toBe(1)
		// Monotonic across pages, not only within one.
		const times = stamps.map(({ now }) => Date.parse(now))
		expect(times).toEqual([...times].sort((left, right) => left - right))
		expect(times[0]).toBe(frozen)
	})

	it('walks owners, then each stop type, then finishes', async () => {
		const unsubscribe: BackfillRow = {
			id: 'u1',
			contactId: 'c00001',
			eventType: 'contact.unsubscribed',
			occurredAt: '2026-09-10T00:00:00.000Z',
		}
		const complaint: BackfillRow = {
			id: 'k1',
			contactId: 'c00002',
			eventType: 'contact.complained',
			occurredAt: '2026-09-11T00:00:00.000Z',
		}
		const { ports } = world({
			owners: 2,
			stops: {
				'contact.unsubscribed': [unsubscribe],
				'contact.complained': [complaint],
			},
		})
		const pages = await drain(ports, 10)
		expect(pages.map((page) => page.phase)).toEqual([
			'owners',
			'double-opt-in',
			'contact.unsubscribed',
			'contact.bounced',
			'contact.complained',
		])
		expect(pages.at(-1)?.next).toEqual({ phase: 'done' })
		const stops = pages.flatMap((page) =>
			page.events.filter((event) => event.type !== 'contact.profile.updated'),
		)
		// Every stop phase re-sends the live facts, under the live keys, for
		// every stopped contact (owned or not). They include org-aihero's
		// directory stop, which writes drovr's suppression row (mig-10), and a
		// backfill re-send dedupes against the live one.
		expect(stops).toEqual([
			{
				tenantId: 'org-aihero',
				contactId: 'c00001',
				journeyId: 'contact-directory',
				type: 'contact.unsubscribed',
				occurredAt: '2026-09-10T00:00:00.000Z',
				idempotencyKey: 'live:u1',
			},
			{
				tenantId: 'org-aihero',
				contactId: 'c00002',
				journeyId: 'contact-directory',
				type: 'contact.complained',
				occurredAt: '2026-09-11T00:00:00.000Z',
				idempotencyKey: 'live:k1',
			},
		])
	})

	it('resumes a phase after its last row, carrying the next stamp forward', async () => {
		const { ports } = world({ owners: 5 })
		const first = await runContactSyncBackfillPage(
			ports,
			{ phase: 'owners' },
			{ pageSize: 2 },
		)
		expect(first.next).toMatchObject({
			phase: 'owners',
			afterId: first.rows.at(-1)?.id,
			afterOccurredAt: first.rows.at(-1)?.occurredAt,
			nextStampMs: frozen + 2,
		})
		const second = await runContactSyncBackfillPage(ports, first.next, {
			pageSize: 2,
		})
		expect(second.rows.map((row) => row.id)).not.toContain(first.rows[0]?.id)
	})

	it('pushes each owned contact once per page and never a synthetic principal', async () => {
		const { ports, stamps } = world({ owners: 2, synthetic: ['synthetic_x'] })
		await drain(ports, 10)
		expect(stamps.map((stamp) => stamp.contactId)).not.toContain('synthetic_x')
	})

	it('profiles only contacts on a drovr sending journey (drovr refuses anyone else)', async () => {
		const { ports, stamps } = world({ owners: 2, otherJourney: ['c-other'] })
		await drain(ports, 10)
		expect(stamps.map((stamp) => stamp.contactId)).toEqual(['c00000', 'c00001'])
	})

	it('profiles double opt-in signups too (drovr runs their double-opt-in journey)', async () => {
		const { ports, stamps } = world({ owners: 1, doubleOptIn: ['c-doi'] })
		const pages = await drain(ports, 10)
		expect(stamps.map((stamp) => stamp.contactId)).toEqual(['c00000', 'c-doi'])
		expect(
			pages
				.find((page) => page.phase === 'double-opt-in')
				?.events.map((event) => event.type),
		).toContain('contact.profile.updated')
	})

	it('pushes no profile for a contact with no email (drovr ignores it as malformed)', async () => {
		const { ports } = world({ owners: 2, noEmail: ['c00001'] })
		const pages = await drain(ports, 10)
		const owners = pages.find((page) => page.phase === 'owners')!
		expect(owners.events.map((event) => event.contactId)).not.toContain(
			'c00001',
		)
		expect(owners.contacts).toBe(1)
	})

	it('is idempotent: a re-run pushes the same versions and keys', async () => {
		const { ports } = world({ owners: 3 })
		const keys = async () =>
			(await drain(ports, 10))
				.flatMap((page) => page.events)
				.map((event) => event.idempotencyKey)
		expect(await keys()).toEqual(await keys())
	})
})

describe('contact sync backfill run', () => {
	function harness(env: Record<string, string>, owners = 3) {
		const { ports } = world({ owners })
		const order: string[] = []
		const sent: { id: string; payload: unknown }[] = []
		const step = {
			run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
				order.push(id)
				return callback()
			}),
			sendEvent: vi.fn(async (id: string, payload: unknown) => {
				order.push(id)
				sent.push({ id, payload })
			}),
		}
		return { ports, step, order, sent }
	}

	it('does nothing while the flag is off', async () => {
		const h = harness({})
		await expect(
			runContactSyncBackfill({
				event: { data: {} },
				step: h.step,
				env: {},
				ports: h.ports,
			}),
		).resolves.toEqual({
			status: 'skipped',
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		expect(h.step.run).not.toHaveBeenCalled()
		expect(h.step.sendEvent).not.toHaveBeenCalled()
	})

	it('sends each page to the bulk delivery lane, at most 100 events per batch', async () => {
		const h = harness({}, 250)
		const receipt = await runContactSyncBackfill({
			event: { data: {} },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			ports: h.ports,
			pageSize: 250,
			pagesPerRun: 1,
		})
		const deliveries = h.sent.filter((entry) => entry.id.startsWith('deliver'))
		const batches = deliveries.flatMap(
			(entry) =>
				entry.payload as {
					name: string
					data: { events: unknown[]; source: string }
				}[],
		)
		expect(batches.map((batch) => batch.name)).toEqual(
			Array(3).fill(DROVR_EVENTS_DELIVER_BULK_EVENT),
		)
		expect(batches.map((batch) => batch.data.events.length)).toEqual([
			100, 100, 50,
		])
		expect(new Set(batches.map((batch) => batch.data.source))).toEqual(
			new Set(['contact-sync-backfill']),
		)
		expect(receipt).toMatchObject({ status: 'continued', contacts: 250 })
	})

	it('re-queues itself with its cursor until done, then stops', async () => {
		const h = harness({}, 3)
		const first = await runContactSyncBackfill({
			event: { data: {} },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			ports: h.ports,
			pageSize: 2,
			pagesPerRun: 1,
		})
		expect(first.status).toBe('continued')
		const continuation = h.sent.find((entry) => entry.id === 'continue')
		expect(continuation?.payload).toEqual({
			name: DROVR_CONTACT_SYNC_BACKFILL_EVENT,
			data: { cursor: expect.objectContaining({ phase: 'owners' }) },
		})
		// Enough pages in one run to reach the end: no continuation.
		const h2 = harness({}, 3)
		const done = await runContactSyncBackfill({
			event: { data: {} },
			step: h2.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			ports: h2.ports,
			pageSize: 10,
			pagesPerRun: 10,
		})
		expect(done.status).toBe('done')
		expect(h2.sent.map((entry) => entry.id)).not.toContain('continue')
	})

	it('a canary (maxPages: 1) runs one page, sends it, and stops without re-queueing', async () => {
		const h = harness({}, 5)
		const receipt = await runContactSyncBackfill({
			event: { data: { maxPages: 1 } },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			ports: h.ports,
			pageSize: 2,
		})
		expect(h.order.filter((id) => id.startsWith('page-'))).toEqual(['page-0'])
		expect(h.sent.map((entry) => entry.id)).toEqual(['deliver-0'])
		expect(receipt).toMatchObject({
			status: 'paused',
			pages: 1,
			contacts: 2,
			cursor: { phase: 'owners', afterId: expect.any(String) },
		})
		// The operator resumes by sending the receipt's cursor back.
		const resumed = harness({}, 5)
		const next = await runContactSyncBackfill({
			event: {
				data: { cursor: (receipt as { cursor: BackfillCursor }).cursor },
			},
			step: resumed.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			ports: resumed.ports,
			pageSize: 2,
			pagesPerRun: 10,
		})
		expect(next).toMatchObject({ status: 'done', contacts: 3 })
	})

	it('a canary stops after its one page even while phases remain', async () => {
		const h = harness({}, 1)
		const receipt = await runContactSyncBackfill({
			event: { data: { maxPages: 1 } },
			step: h.step,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			ports: h.ports,
			pageSize: 10,
		})
		// One page per phase: owners fit, the stop phases still remain.
		expect(receipt).toMatchObject({ status: 'paused', pages: 1 })
		expect(h.sent.map((entry) => entry.id)).not.toContain('continue')
	})

	it('refuses a maxPages that is not a positive whole number', async () => {
		for (const maxPages of [0, -1, 1.5]) {
			const h = harness({})
			await expect(
				runContactSyncBackfill({
					event: { data: { maxPages } },
					step: h.step,
					env: { AIH_DROVR_PROFILE_SYNC: 'true' },
					ports: h.ports,
				}),
			).rejects.toThrow(/maxPages/)
			expect(h.step.run).not.toHaveBeenCalled()
		}
	})
})

describe('contact sync backfill: stopBeforePhase', () => {
	const stopRow = (id: string): BackfillRow => ({
		id,
		contactId: `stopped-${id}`,
		eventType: 'contact.unsubscribed',
		occurredAt: '2026-09-26T00:00:00.000Z',
	})
	function slice(owners: number) {
		const { ports } = world({
			owners,
			stops: { 'contact.unsubscribed': [stopRow('u1'), stopRow('u2')] },
		})
		const scanned: string[] = []
		const scanEvents = ports.scanEvents
		const spied: BackfillPorts = {
			...ports,
			scanEvents: async (args) => {
				scanned.push(args.eventType)
				return scanEvents(args)
			},
		}
		const sent: { id: string; payload: unknown }[] = []
		const step = {
			run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
				callback(),
			),
			sendEvent: vi.fn(async (id: string, payload: unknown) => {
				sent.push({ id, payload })
			}),
		}
		return { ports: spied, step, scanned, sent }
	}
	const env = { AIH_DROVR_PROFILE_SYNC: 'true' }

	it('with stopBeforePhase "stops", a run never enters the stop phases', async () => {
		const h = slice(3)
		const receipt = await runContactSyncBackfill({
			event: { data: { stopBeforePhase: 'stops' } },
			step: h.step,
			env,
			ports: h.ports,
			pageSize: 10,
			pagesPerRun: 10,
		})
		expect(h.scanned).not.toContain('contact.unsubscribed')
		expect(
			h.scanned.some((type) => BACKFILL_STOP_PHASES.includes(type as never)),
		).toBe(false)
		expect(receipt).toMatchObject({
			status: 'paused',
			contacts: 3,
			cursor: { phase: 'contact.unsubscribed' },
		})
		expect(h.sent.map((entry) => entry.id)).not.toContain('continue')
	})

	it('with stopBeforePhase "double-opt-in", it stops exactly at the end of owners', async () => {
		const h = slice(3)
		const receipt = await runContactSyncBackfill({
			event: { data: { stopBeforePhase: 'double-opt-in' } },
			step: h.step,
			env,
			ports: h.ports,
			pageSize: 10,
			pagesPerRun: 10,
		})
		expect(h.scanned).toEqual(['journey.owner.assigned'])
		expect(receipt).toMatchObject({
			status: 'paused',
			pages: 1,
			cursor: { phase: 'double-opt-in' },
		})
	})

	it('a slice that ends mid-phase is unchanged: paused on the owners cursor', async () => {
		const h = slice(5)
		const receipt = await runContactSyncBackfill({
			event: { data: { maxPages: 1, stopBeforePhase: 'double-opt-in' } },
			step: h.step,
			env,
			ports: h.ports,
			pageSize: 2,
		})
		expect(receipt).toMatchObject({
			status: 'paused',
			pages: 1,
			cursor: { phase: 'owners', afterId: expect.any(String) },
		})
	})

	it('a re-queued run carries stopBeforePhase forward', async () => {
		const h = slice(5)
		const receipt = await runContactSyncBackfill({
			event: { data: { stopBeforePhase: 'stops' } },
			step: h.step,
			env,
			ports: h.ports,
			pageSize: 2,
			pagesPerRun: 1,
		})
		expect(receipt).toMatchObject({ status: 'continued' })
		expect(h.sent.find((entry) => entry.id === 'continue')?.payload).toEqual({
			name: DROVR_CONTACT_SYNC_BACKFILL_EVENT,
			data: {
				cursor: expect.objectContaining({ phase: 'owners' }),
				stopBeforePhase: 'stops',
			},
		})
	})

	it('reads nothing when the cursor is already at the stop', async () => {
		const h = slice(3)
		const receipt = await runContactSyncBackfill({
			event: {
				data: {
					cursor: { phase: 'contact.unsubscribed' },
					stopBeforePhase: 'stops',
				},
			},
			step: h.step,
			env,
			ports: h.ports,
		})
		expect(h.scanned).toEqual([])
		expect(receipt).toMatchObject({ status: 'paused', pages: 0 })
	})

	it('refuses an unknown stopBeforePhase', async () => {
		const h = slice(3)
		await expect(
			runContactSyncBackfill({
				event: { data: { stopBeforePhase: 'owners' as never } },
				step: h.step,
				env,
				ports: h.ports,
			}),
		).rejects.toThrow(/stopBeforePhase/)
		expect(h.step.run).not.toHaveBeenCalled()
	})
})
