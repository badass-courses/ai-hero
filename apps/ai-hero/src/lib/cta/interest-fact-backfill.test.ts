import type { InterestFactRequested } from '@/inngest/events/interest-fact'
import type { DrovrContactResolution } from '@/lib/subscriber-marketing/drovr-purchase-resolve'
import { describe, expect, it, vi } from 'vitest'

import {
	backfillEventId,
	backfillKeys,
	BackfillRefused,
	createPacer,
	runInterestBackfill,
	type BackfillDeps,
	type BackfillEvent,
} from './interest-fact-backfill'
import {
	recordInterestFact,
	type InterestFactRecorderDeps,
} from './interest-fact-recorder'
import type { DrovrInterestFact } from './interest-facts'
import { requestInterestFacts } from './interest-facts.server'

vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const SF = 'waitlist_software_factories_for_real_engineers'
const CC = 'interest_ai_coding_crash_course'
const NOW = Date.parse('2026-11-01T12:00:00Z')

/** A synthetic Kit export line. */
function row(
	n: number,
	fields: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	return JSON.stringify({
		id: 1000 + n,
		state: 'active',
		first_name: `Person ${n}`,
		email_address: `person${n}@example.test`,
		created_at: '2025-03-01T10:00:00Z',
		fields,
		tags: [],
		...extra,
	})
}

async function* linesOf(lines: readonly string[]) {
	for (const line of lines) yield line
}

/** A clock whose sleep moves time, so pacing runs instantly. */
function fakeClock(start = NOW) {
	let now = start
	const sleeps: number[] = []
	return {
		sleeps,
		clock: {
			now: () => now,
			sleep: async (ms: number) => {
				sleeps.push(ms)
				now += ms
			},
		},
	}
}

function harness(
	lines: readonly string[],
	overrides: Partial<BackfillDeps> & {
		known?: (email: string) => boolean
		stopAfterBatches?: number
		cursor?: { line: number }
	} = {},
) {
	const known = overrides.known ?? (() => true)
	const sent: BackfillEvent[][] = []
	const cursor = overrides.cursor ?? { line: 0 }
	const { clock, sleeps } = fakeClock()
	const deps: BackfillDeps = {
		mode: 'send',
		keys: [SF, CC],
		lines: linesOf(lines),
		findContactIdForEmail: async (email) =>
			known(email) ? `local:${email}` : undefined,
		resolveDrovr: async (emails) =>
			new Map<string, DrovrContactResolution>(
				emails.map((email) => [
					email.toLowerCase(),
					known(email)
						? { status: 'resolved', contactId: `drovr:${email}` }
						: { status: 'missing' },
				]),
			),
		send: async (events) => {
			sent.push(events)
		},
		stopRequested: async () =>
			overrides.stopAfterBatches !== undefined &&
			sent.length >= overrides.stopAfterBatches,
		readCursor: async () => cursor.line,
		writeCursor: async (line) => {
			cursor.line = line
		},
		clock,
		ratePerSecond: 2,
		...overrides,
	}
	return { deps, sent, cursor, sleeps }
}

describe('interest backfill keys', () => {
	it('defaults to the four live keys', () => {
		expect(backfillKeys()).toEqual([
			SF,
			CC,
			'interest_ai_skills_for_real_engineers',
			'interest_workshop_2ozd9',
		])
	})

	it('takes a subset and refuses any key that is not live', () => {
		expect(backfillKeys(` ${CC} ,${CC}`)).toEqual([CC])
		expect(() => backfillKeys('aih_readiness_intent')).toThrow(BackfillRefused)
		expect(() => backfillKeys(`${CC},waitlist_some_other_product`)).toThrow(
			/not a live key/,
		)
		expect(() => backfillKeys(' , ')).toThrow(BackfillRefused)
	})

	it('reads only the requested keys from the export', async () => {
		const { deps, sent } = harness(
			[row(1, { [SF]: '2026-10-01', [CC]: '2026-10-02' })],
			{ keys: [CC] },
		)
		const report = await runInterestBackfill(deps)
		expect(sent.flat().map((event) => event.data.fieldKey)).toEqual([CC])
		expect(Object.keys(report.perKey)).toEqual([CC])
	})
})

describe('interest backfill dry run', () => {
	it('counts holders by state, resolution and date, and sends nothing', async () => {
		const send = vi.fn()
		const writeCursor = vi.fn()
		const { deps } = harness(
			[
				row(1, { [SF]: '2026-10-01' }),
				row(
					2,
					{ [SF]: '2026-10-02', [CC]: '2026-09-01' },
					{ state: 'inactive' },
				),
				row(3, { [SF]: 'yes' }),
				row(4, { [SF]: 'yes' }, { created_at: 'not a date' }),
				row(5, { [SF]: '', [CC]: null }),
				row(6, { unrelated_field: 'x' }),
				'{ not json waitlist_software_factories_for_real_engineers',
				'',
			],
			{
				mode: 'dry-run',
				send,
				writeCursor,
				known: (email) => email !== 'person3@example.test',
			},
		)
		const report = await runInterestBackfill(deps)
		expect(send).not.toHaveBeenCalled()
		expect(writeCursor).not.toHaveBeenCalled()
		expect(report.malformedLines).toBe(1)
		expect(report.perKey[SF]).toMatchObject({
			holders: 4,
			byState: { active: 3, inactive: 1 },
			local: { resolved: 3, unresolved: 1 },
			drovr: { resolved: 3, missing: 1 },
			resolvable: 3,
			date: { field: 2, createdAt: 1, none: 1 },
			sent: 0,
		})
		expect(report.perKey[CC]).toMatchObject({ holders: 1, resolvable: 1 })
		// Counts only: no address leaks into the report.
		expect(JSON.stringify(report)).not.toContain('@example.test')
	})

	it('reports drovr as not checked when it is not configured', async () => {
		const { deps } = harness([row(1, { [SF]: '2026-10-01' })], {
			mode: 'dry-run',
			resolveDrovr: undefined,
		})
		const report = await runInterestBackfill(deps)
		expect(report.perKey[SF]!.drovr['not-checked']).toBe(1)
		expect(report.perKey[SF]!.resolvable).toBe(0)
	})
})

describe('interest backfill send', () => {
	it('sends resolvable holders with Kit dates as backfill events', async () => {
		const { deps, sent } = harness(
			[
				row(1, { [SF]: '2026-10-01' }),
				row(2, { [SF]: '2026-10-02' }),
				row(3, { [SF]: 'yes' }, { created_at: 'never' }),
			],
			{ known: (email) => email !== 'person2@example.test' },
		)
		const report = await runInterestBackfill(deps)
		expect(sent.flat()).toEqual([
			{
				id: backfillEventId(SF, 'person1@example.test'),
				name: 'aihero/interest.fact.requested',
				data: {
					email: 'person1@example.test',
					fieldKey: SF,
					expressedAt: '2026-10-01T00:00:00.000Z',
					via: 'backfill',
				},
			},
		])
		expect(report.perKey[SF]).toMatchObject({
			sent: 1,
			skippedUnresolved: 1,
			skippedNoDate: 1,
		})
	})

	it('sends unresolved holders only when asked', async () => {
		const { deps, sent } = harness([row(1, { [SF]: '2026-10-01' })], {
			known: () => false,
			includeUnresolved: true,
		})
		await runInterestBackfill(deps)
		expect(sent.flat()).toHaveLength(1)
	})

	it('refuses to send without drovr resolution to choose holders', async () => {
		const { deps } = harness([row(1, { [SF]: '2026-10-01' })], {
			resolveDrovr: undefined,
		})
		await expect(runInterestBackfill(deps)).rejects.toThrow(BackfillRefused)
	})

	it('gives a person and key one id, whatever the case', () => {
		const id = backfillEventId(SF, 'Person1@Example.test ')
		expect(id).toBe(backfillEventId(SF, 'person1@example.test'))
		expect(id).toBe(`interest-backfill:${SF}:${id.slice(-16)}`)
		expect(id.slice(-16)).toMatch(/^[0-9a-f]{16}$/)
		expect(id).not.toContain('person1')
		expect(backfillEventId(CC, 'person1@example.test')).not.toBe(id)
		expect(backfillEventId(SF, 'person2@example.test')).not.toBe(id)
	})
})

describe('interest backfill stop switch and resume', () => {
	const exportLines = Array.from({ length: 7 }, (_, i) =>
		row(i + 1, {
			[SF]: '2026-10-01',
			...(i === 2 ? { [CC]: '2026-10-03' } : {}),
		}),
	)

	it('stops before the next batch, and a rerun sends the rest once', async () => {
		const first = harness(exportLines, { stopAfterBatches: 1 })
		const stopped = await runInterestBackfill(first.deps)
		expect(stopped.stopped).toBe(true)
		expect(first.sent.flat()).toHaveLength(2)
		expect(first.cursor.line).toBe(2)

		const second = harness(exportLines, { cursor: first.cursor })
		const resumed = await runInterestBackfill(second.deps)
		expect(resumed.stopped).toBe(false)
		expect(resumed.resumedFromLine).toBe(2)
		const ids = [...first.sent.flat(), ...second.sent.flat()].map((e) => e.id)
		expect(ids).toHaveLength(8)
		expect(new Set(ids).size).toBe(8)
		expect(second.cursor.line).toBe(7)
	})

	it('never moves the cursor past a line with an unsent event', async () => {
		// At 3 a second the first batch ends inside line 3, which holds two keys.
		const first = harness(exportLines, { stopAfterBatches: 1, ratePerSecond: 3 })
		await runInterestBackfill(first.deps)
		const firstIds = first.sent.flat().map((e) => e.id)
		expect(firstIds).toHaveLength(3)
		expect(first.cursor.line).toBe(2)

		const second = harness(exportLines, { cursor: first.cursor })
		await runInterestBackfill(second.deps)
		const secondIds = second.sent.flat().map((e) => e.id)
		// Line 3's sent event goes again under the same id, so Inngest drops it.
		expect(secondIds).toContain(firstIds[2])
		expect(new Set([...firstIds, ...secondIds]).size).toBe(8)
	})

	it('a finished run rerun sends nothing', async () => {
		const first = harness(exportLines)
		await runInterestBackfill(first.deps)
		const second = harness(exportLines, { cursor: first.cursor })
		await runInterestBackfill(second.deps)
		expect(second.sent).toEqual([])
	})
})

describe('interest backfill pacing', () => {
	it('holds 2 events a second, with no sleep before the first', async () => {
		const lines = Array.from({ length: 5 }, (_, i) =>
			row(i + 1, { [SF]: '2026-10-01' }),
		)
		const { deps, sent, sleeps } = harness(lines)
		await runInterestBackfill(deps)
		expect(sent.map((batch) => batch.length)).toEqual([2, 2, 1])
		expect(sleeps).toEqual([1000, 1000])
	})

	it('spreads a sub-1 rate across single-event batches', async () => {
		const { clock, sleeps } = fakeClock()
		const pacer = createPacer(0.5, clock)
		expect(pacer.batchSize).toBe(1)
		await pacer.before(1)
		await pacer.before(1)
		await pacer.before(1)
		expect(sleeps).toEqual([2000, 2000])
	})

	it('counts a slow send against the wait', async () => {
		const { clock, sleeps } = fakeClock()
		const pacer = createPacer(2, clock)
		await pacer.before(2)
		await clock.sleep(400)
		await pacer.before(2)
		expect(sleeps).toEqual([400, 600])
	})

	it('refuses a rate that is not positive', () => {
		expect(() => createPacer(0, fakeClock().clock)).toThrow(BackfillRefused)
		expect(() => createPacer(Number.NaN, fakeClock().clock)).toThrow(
			BackfillRefused,
		)
	})
})

describe('backfilled and live joins are one drovr fact', () => {
	/** drovr's first-wins store and a local store, as the recorder sees them. */
	function stores() {
		const drovr = new Map<string, DrovrInterestFact>()
		const local = new Map<string, string>()
		const deps: InterestFactRecorderDeps = {
			findContactIdForEmail: async (email) => `local:${email.toLowerCase()}`,
			writeLocalInterestFact: async ({ contactId, fieldKey, at }) => {
				const key = `${contactId}:${fieldKey}`
				const existing = local.get(key)
				if (existing) return { status: 'existing', occurredAt: existing }
				local.set(key, at)
				return { status: 'inserted', occurredAt: at }
			},
			drovr: {
				resolve: async (email) => ({
					status: 'resolved',
					contactId: `drovr:${email.trim().toLowerCase()}`,
				}),
				record: async (fact) => {
					if (!drovr.has(fact.sourceId)) drovr.set(fact.sourceId, fact)
				},
			},
		}
		return { deps, drovr }
	}

	async function liveJoin(email: string) {
		vi.stubEnv('AIH_INTEREST_FACTS_ENABLED', 'true')
		const events: InterestFactRequested[] = []
		await requestInterestFacts({
			email,
			fields: { [SF]: '2026-11-01' },
			expressedAt: new Date('2026-11-01T09:00:00Z'),
			via: 'one-click',
			sender: { send: async (batch) => void events.push(...batch) },
		})
		vi.unstubAllEnvs()
		expect(events).toHaveLength(1)
		return events[0]!
	}

	async function backfillJoin(email: string) {
		const { deps, sent } = harness([
			JSON.stringify({
				id: 1,
				state: 'active',
				email_address: email,
				created_at: '2025-01-01T00:00:00Z',
				fields: { [SF]: '2026-10-01' },
				tags: [],
			}),
		])
		await runInterestBackfill({ ...deps, keys: [SF] })
		expect(sent.flat()).toHaveLength(1)
		return sent.flat()[0]!
	}

	it('a live join after the backfill is a repeat at the Kit date', async () => {
		const { deps, drovr } = stores()
		const backfill = await backfillJoin('Reader@Example.test')
		const live = await liveJoin('reader@example.test')
		expect(await recordInterestFact(deps, backfill.data)).toEqual({
			local: 'inserted',
			drovr: 'recorded',
		})
		expect((await recordInterestFact(deps, live.data)).local).toBe('existing')
		expect([...drovr.values()]).toEqual([
			expect.objectContaining({
				role: SF,
				at: '2026-10-01T00:00:00.000Z',
			}),
		])
	})

	it('a backfill after a live join is a repeat too', async () => {
		const { deps, drovr } = stores()
		const live = await liveJoin('reader@example.test')
		const backfill = await backfillJoin('reader@example.test')
		await recordInterestFact(deps, live.data)
		await recordInterestFact(deps, backfill.data)
		expect(drovr.size).toBe(1)
	})
})
