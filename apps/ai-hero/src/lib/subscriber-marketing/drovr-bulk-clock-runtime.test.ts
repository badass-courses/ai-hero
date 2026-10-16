import { afterEach, expect, it, vi } from 'vitest'
import { RetryAfterError } from 'inngest'
import {
	nextBulkSlot,
	runPacedSend,
	waitForBulkSlot,
	BULK_RESERVATION_INTERVAL_MS,
	type BulkClass,
	type BulkCursors,
	type PaceStep,
} from './drovr-bulk-pace'
import { BulkPaceYieldError } from './drovr-bulk-permit'
import {
	deliverDrovrShadowEvent,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { sampleBulkClock, type BulkClockProbe } from './drovr-bulk-clock'
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
afterEach(() => {
	vi.useRealTimers()
})
const base = Date.parse('2032-01-01T00:00:00.000Z')
const event = (index: number): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	journeyId: 'contact-directory',
	contactId: `clock-fixture-${index}`,
	type: 'contact.profile.updated',
	occurredAt: new Date(base).toISOString(),
	idempotencyKey: `clock-fixture:${index}`,
	payload: {
		profileVersion: 1,
		email: 'learner@example.test',
		firstName: null,
		holds: [],
	},
})
const exactClock: BulkClockProbe = async () => ({
	utcMs: Date.now(),
	rttMs: 0,
	precisionMs: 0,
	monotonicAt: Date.now(),
	monotonicNow: Date.now,
})
it('200 actual transport starts share the DB grid despite opposite ±5s app offsets', async () => {
	vi.useFakeTimers()
	let physical = base
	let offset = -5000
	vi.setSystemTime(physical + offset)
	let cursors: BulkCursors = {}
	const starts: number[] = []
	const offsets = new Set<number>()
	const completed: boolean[] = []
	const classes: BulkClass[] = [
		...Array<BulkClass>(12).fill('delta'),
		...Array<BulkClass>(4).fill('restate'),
		...Array<BulkClass>(3).fill('ingest'),
		'backfill',
	]
	const firstIndex = Math.ceil(base / BULK_RESERVATION_INTERVAL_MS)
	const clock: BulkClockProbe = async () => ({
		utcMs: physical,
		rttMs: 0,
		precisionMs: 0,
		monotonicAt: physical,
		monotonicNow: () => physical,
	})
	const step: PaceStep = {
		run: async (_id, fn) => fn(),
		sleepUntil: async (_id, at) => {
			physical = Math.max(physical, at.getTime())
			vi.setSystemTime(physical + offset)
		},
	}
	const reserve = async (kind: BulkClass = 'delta') => {
		const next = nextBulkSlot(cursors, kind, physical)
		cursors = next.cursors
		return next.slot
	}
	const fetcher = vi.fn(async () => {
		starts.push(physical)
		offsets.add(Date.now() - physical)
		return new Response(null, { status: 202 })
	}) as unknown as typeof fetch
	for (let index = 0; index < 200; index++) {
		offset = index % 2 ? 5000 : -5000
		vi.setSystemTime(physical + offset)
		try {
			await runPacedSend(
				step,
				`offset:${index}`,
				(id) =>
					waitForBulkSlot(
						step,
						id,
						classes[(firstIndex + index) % classes.length]!,
						reserve,
					),
				() =>
					deliverDrovrShadowEvent({
						event: event(index),
						config: {
							ingestUrl: 'https://drovr.example.test/events',
							apiKey: 'synthetic',
						},
						fetcher,
						clampAt: base,
					}),
				0,
				clock,
			)
			completed.push(true)
		} catch {
			completed.push(false)
		}
	}
	expect(completed).toEqual(Array(200).fill(true))
	expect(starts).toHaveLength(200)
	expect(offsets).toEqual(new Set([-5000, 5000]))
	for (const at of starts)
		expect(
			starts.filter((other) => other >= at && other <= at + 60000).length,
		).toBeLessThanOrEqual(100)
})
it('the real sampler admits a250ms query only when its full projected UTC interval fits at actual fetch', async () => {
	let mono = 0
	let cursors: BulkCursors = {}
	const starts: number[] = []
	const perf = vi.spyOn(performance, 'now').mockImplementation(() => mono)
	const wall = vi
		.spyOn(Date, 'now')
		.mockImplementation(() => base + mono + 5000)
	try {
		const firstSlot = nextBulkSlot({}, 'delta', base).slot
		const reserve = vi.fn(async () => {
			const next = nextBulkSlot(cursors, 'delta', base + mono)
			cursors = next.cursors
			return next.slot
		})
		const step: PaceStep = {
			run: async (_id, fn) => fn(),
			sleepUntil: async (_id, at) => {
				mono = Math.max(mono, at.getTime() - base)
			},
		}
		const query = vi.fn(async () => {
			const utc = base + mono
			mono += 250
			return [[{ now: String(utc) }]]
		})
		const release = vi.fn()
		const probe = () => sampleBulkClock(async () => ({ query, release }))
		const fetcher = vi.fn(async () => {
			starts.push(base + mono)
			return new Response(null, { status: 202 })
		}) as unknown as typeof fetch
		await expect(
			runPacedSend(
				step,
				'rtt-boundary',
				(id) => waitForBulkSlot(step, id, 'delta', reserve),
				() =>
					deliverDrovrShadowEvent({
						event: event(250),
						config: {
							ingestUrl: 'https://drovr.example.test/events',
							apiKey: 'synthetic',
						},
						fetcher,
						clampAt: base,
					}),
				0,
				probe,
			),
		).resolves.toMatchObject({ status: 'accepted' })
		expect(starts).toEqual([firstSlot + 250])
		expect(query).toHaveBeenCalledOnce()
		expect(reserve).toHaveBeenCalledOnce()
		expect(release).toHaveBeenCalledOnce()
	} finally {
		perf.mockRestore()
		wall.mockRestore()
	}
})
it('slow RTT rebooks and yields without transport or any HTTP attempt', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(base)
	const step: PaceStep = {
		run: async (_id, fn) => fn(),
		sleepUntil: async (_id, at) => {
			vi.setSystemTime(at)
		},
	}
	const reserve = vi.fn(async () => Date.now() + 604)
	const probe: BulkClockProbe = vi.fn(async () => ({
		utcMs: Date.now(),
		rttMs: 251,
		precisionMs: 1,
		monotonicAt: Date.now(),
		monotonicNow: Date.now,
	}))
	const post = vi.fn()
	await expect(
		runPacedSend(
			step,
			'slow-clock',
			(id) => waitForBulkSlot(step, id, 'delta', reserve),
			post,
			0,
			probe,
		),
	).rejects.toBeInstanceOf(BulkPaceYieldError)
	expect(probe).toHaveBeenCalledTimes(3)
	expect(reserve).toHaveBeenCalledTimes(3)
	expect(post).not.toHaveBeenCalled()
})
it('SDK replay returns the real cached transport receipt without sampling or posting again', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(base)
	const memo = new Map<string, unknown>()
	const step: PaceStep = {
		run: async (id, fn) => {
			if (!memo.has(id)) memo.set(id, await fn())
			return memo.get(id)
		},
		sleepUntil: async (_id, at) => {
			vi.setSystemTime(Math.max(Date.now(), at.getTime()))
		},
	}
	const probe = vi.fn(exactClock)
	const reserve = vi.fn(async () => Date.now() + 604)
	const fetcher = vi.fn(
		async () => new Response(null, { status: 202 }),
	) as unknown as typeof fetch
	const send = () =>
		deliverDrovrShadowEvent({
			event: event(999),
			config: {
				ingestUrl: 'https://drovr.example.test/events',
				apiKey: 'synthetic',
			},
			fetcher,
			clampAt: base,
		})
	const pace = (id: string) => waitForBulkSlot(step, id, 'delta', reserve)
	expect(
		(await runPacedSend(step, 'cached-wire', pace, send, 0, probe)).status,
	).toBe('accepted')
	vi.setSystemTime(Date.now() + 30000)
	expect(
		(await runPacedSend(step, 'cached-wire', pace, send, 8, probe)).status,
	).toBe('accepted')
	expect(fetcher).toHaveBeenCalledOnce()
	expect(probe).toHaveBeenCalledOnce()
	expect(reserve).toHaveBeenCalledOnce()
})
for (const kind of ['numeric', 'Date', 'ISO'] as const)
	it(`honors ${kind} Retry-After using the sampled DB clock`, async () => {
		vi.useFakeTimers()
		vi.setSystemTime(base)
		const sleeps: { id: string; at: number }[] = []
		const step: PaceStep = {
			run: async (_id, fn) => fn(),
			sleepUntil: async (id, at) => {
				sleeps.push({ id, at: at.getTime() })
				vi.setSystemTime(at)
			},
		}
		const reserve = async () => Date.now() + 604
		const post = vi.fn(async (attempt: number) => {
			if (!attempt) {
				const error = new RetryAfterError('synthetic retry', 1)
				const at = Date.now() + 3000
				Object.defineProperty(error, 'retryAfter', {
					value:
						kind === 'numeric'
							? 3
							: kind === 'Date'
								? new Date(at)
								: new Date(at).toISOString(),
				})
				throw error
			}
			return { accepted: 1 }
		})
		await expect(
			runPacedSend(
				step,
				`retry-${kind}`,
				(id) => waitForBulkSlot(step, id, 'delta', reserve),
				post,
				0,
				exactClock,
			),
		).resolves.toEqual({ accepted: 1 })
		expect(
			sleeps.filter((row) => row.id.endsWith(':retry')).map((row) => row.at),
		).toEqual([base + 3604])
		expect(post.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1])
	})
it('never adds a retry sleep after the terminal failed HTTP attempt', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(base)
	const sleeps: string[] = []
	const step: PaceStep = {
		run: async (_id, fn) => fn(),
		sleepUntil: async (id, at) => {
			sleeps.push(id)
			vi.setSystemTime(at)
		},
	}
	const post = vi.fn(async () => {
		throw new Error('synthetic final storage outage')
	})
	await expect(
		runPacedSend(
			step,
			'terminal',
			(id) => waitForBulkSlot(step, id, 'delta', async () => Date.now() + 604),
			post,
			0,
			exactClock,
		),
	).rejects.toThrow('PacedDelivery:')
	expect(post).toHaveBeenCalledTimes(9)
	expect(sleeps.filter((id) => id.endsWith(':retry'))).toHaveLength(8)
})
