import { afterEach, expect, it, vi } from 'vitest'
import { RetryAfterError } from 'inngest'
import { reserveBulkSlot, nextBulkSlot, runPacedSend, waitForBulkSlot, BULK_RESERVATION_INTERVAL_MS, type BulkCursors, type BulkClass, type PaceStep } from './drovr-bulk-pace'
import { BulkPaceYieldError, BULK_SLOT_TOLERANCE_MS } from './drovr-bulk-permit'
import { deliverDrovrShadowEvent, type DrovrShadowEvent } from './drovr-shadow-emitter'
import { sendOrOutbox } from './drovr-outbox-step'
import type { BulkClockProbe } from './drovr-bulk-clock'
const exactClock: BulkClockProbe = async () => ({ utcMs: Date.now(), rttMs: 0, precisionMs: 0, monotonicAt: Date.now(), monotonicNow: Date.now })
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
afterEach(() => { vi.useRealTimers() })
const event = (id: number): DrovrShadowEvent => ({ tenantId: 'org-aihero', journeyId: 'contact-directory', type: 'contact.profile.updated', contactId: `synthetic-${id}`, occurredAt: '2032-01-01T00:00:00.000Z', idempotencyKey: `synthetic:${id}`, payload: { profileVersion: 1, email: 'learner@example.test', firstName: null, holds: [] } })
function database(initial: BulkCursors = {}, utc: unknown = 1000) {
 let cursor = JSON.stringify(initial)
 const query = vi.fn(async (sql: string, values?: unknown[]) => {
  if (sql.startsWith('SELECT `name`')) return [[{ name: 'existing' }]]
  if (sql.includes('FOR UPDATE')) return [[{ cursor, now: utc }]]
  if (sql.startsWith('UPDATE')) cursor = String(values![0])
  return [[], []]
 })
 const connection = { query, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), release: vi.fn() }
 return { connection, acquire: vi.fn(async () => connection), query }
}
it('seeds once and compares an independent UTC clock without changing pooled sessions', async () => {
 const db = database()
 const a = await reserveBulkSlot(db.acquire, 'pace_table', 'delta')
 const b = await reserveBulkSlot(db.acquire, 'pace_table', 'delta')
 expect(Number(b) - Number(a)).toBe(604)
 expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT `name`'))).toHaveLength(1)
 expect(db.query.mock.calls.filter(([sql]) => sql.includes('FOR UPDATE'))).toHaveLength(2)
 expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('SET '))).toHaveLength(0)
 expect(db.query.mock.calls.filter(([sql]) => sql.includes('UTC_TIMESTAMP(6)'))).toHaveLength(2)
 expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(0)
 expect(db.connection.commit).toHaveBeenCalledTimes(2)
})
it('ignores app wall-clock offsets, rejects an invalid DB clock, and treats lookahead as healthy backpressure', async () => {
 vi.useFakeTimers(); vi.setSystemTime(9000)
 await expect(reserveBulkSlot(database().acquire, 'pace_table', 'delta')).resolves.toBeTypeOf('number')
 const wrong = database({}, NaN)
 await expect(reserveBulkSlot(wrong.acquire, 'pace_table', 'delta')).rejects.toThrow('BulkClock:')
 expect(wrong.connection.rollback).toHaveBeenCalledOnce()
 const far = database({ backfill: 1000000 })
 await expect(reserveBulkSlot(far.acquire, 'pace_table', 'backfill')).resolves.toEqual({ retryAt: 61000 })
 expect(far.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
 await expect(reserveBulkSlot(far.acquire, 'pace_table', 'delta')).resolves.toBeTypeOf('number')
})
it('the production allocator keeps classes disjoint and protects deltas from background backlog', () => {
 let cursors: BulkCursors = {}
 const slots: { at: number; kind: BulkClass }[] = []
 for (let index = 0; index < 90; index++) {
  const kind: BulkClass = index % 3 === 0 ? 'backfill' : index % 3 === 1 ? 'ingest' : 'restate'
  const next = nextBulkSlot(cursors, kind, 0); cursors = next.cursors; slots.push({ at: next.slot, kind })
 }
 for (let index = 0; index < 120; index++) {
  const next = nextBulkSlot(cursors, 'delta', 0); cursors = next.cursors; slots.push({ at: next.slot, kind: 'delta' })
 }
 expect(slots.find(row => row.kind === 'delta')!.at).toBe(0)
 expect(new Set(slots.map(row => row.at)).size).toBe(slots.length)
 for (const row of slots) expect(slots.filter(other => other.at >= row.at && other.at <= row.at + 60000).length).toBeLessThanOrEqual(100)
 expect(Object.fromEntries((['delta', 'restate', 'ingest', 'backfill'] as BulkClass[]).map(kind => [kind, slots.filter(row => row.kind === kind && row.at < 60000).length]))).toEqual({ delta: 60, restate: 20, ingest: 15, backfill: 5 })
 expect(() => nextBulkSlot({ delta: NaN }, 'delta', 0)).toThrow('BulkCursor:')
 // Closed-window proof, including maximum permitted lateness of the first POST.
 expect(100 * BULK_RESERVATION_INTERVAL_MS - BULK_SLOT_TOLERANCE_MS).toBeGreaterThan(60000)
})
it('HTTP retries get fresh reservations; outer replay neither posts again nor spends a fresh HTTP attempt', async () => {
 vi.useFakeTimers(); vi.setSystemTime(0)
 const memo = new Map<string, unknown>(); let clock = 0; const sleeps: number[] = []
 const step: PaceStep = {
  run: async (id, fn) => { if (!memo.has(id)) memo.set(id, await fn()); return memo.get(id) },
  sleepUntil: async (_id, date) => { sleeps.push(date.getTime()); clock = Math.max(clock, date.getTime()); vi.setSystemTime(clock) },
 }
 const reserve = vi.fn(async (_kind: BulkClass = 'delta') => clock + 604)
 const pace = (id: string) => waitForBulkSlot(step, id, 'delta', reserve)
 const post = vi.fn(async (attempt: number) => { if (!attempt) throw new RetryAfterError('synthetic failure', 1000); return { accepted: 1 } })
 expect(await runPacedSend(step, 'event', pace, post, 5, exactClock)).toEqual({ accepted: 1 })
 expect(post.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1])
 expect(reserve).toHaveBeenCalledTimes(2)
 expect(sleeps).toEqual([604, 1604, 2208])
 await runPacedSend(step, 'event', pace, post, 8, exactClock)
 expect(post).toHaveBeenCalledTimes(2); expect(reserve).toHaveBeenCalledTimes(2)
})
it('rechecks freshness at transport after async work, without outboxing or spending an HTTP attempt', async () => {
 vi.useFakeTimers(); vi.setSystemTime(0)
 const capture = vi.fn(); const starts: number[] = []; const attempts: number[] = []
 const fetcher = vi.fn(async () => { starts.push(Date.now()); return new Response(null, { status: 202 }) }) as unknown as typeof fetch
 const step: PaceStep = { run: async (_id, fn) => fn(), sleepUntil: async (_id, date) => { vi.setSystemTime(date) } }
 const reserve = vi.fn(async () => Date.now() + 604)
 const answer = await runPacedSend(step, 'late-transport', id => waitForBulkSlot(step, id, 'delta', reserve), async attempt => {
  attempts.push(attempt)
  if (attempts.length === 1) vi.setSystemTime(Date.now() + 301)
  return sendOrOutbox({ attempt: { attempt: 8, maxAttempts: 9 }, capture, unsent: () => [], outboxed: () => ({ status: 'accepted' as const }), send: () => deliverDrovrShadowEvent({ event: event(1), config: { ingestUrl: 'https://example.test/events', apiKey: 'synthetic' }, clampAt: 0, fetcher }) })
 }, 0, exactClock)
 expect(answer).toEqual({ status: 'accepted' }); expect(attempts).toEqual([0, 0])
 expect(starts).toHaveLength(1); expect(capture).not.toHaveBeenCalled(); expect(reserve).toHaveBeenCalledTimes(2)
})
it('bounds healthy capacity waits without invoking transport or consuming HTTP attempts', async () => {
 vi.useFakeTimers(); vi.setSystemTime(0)
 const step: PaceStep = { run: async (_id, fn) => fn(), sleepUntil: async (_id, date) => { vi.setSystemTime(date) } }
 const reserve = vi.fn(async () => ({ retryAt: Date.now() + 60000 })); const post = vi.fn()
 await expect(runPacedSend(step, 'full', id => waitForBulkSlot(step, id, 'delta', reserve), post, 0, exactClock)).rejects.toBeInstanceOf(BulkPaceYieldError)
 expect(reserve).toHaveBeenCalledTimes(3); expect(post).not.toHaveBeenCalled(); expect(Date.now()).toBe(180000)
})
it('a delayed batch of workers rebooks expired slots and never bunches over 100 actual POST starts in a closed sliding minute', async () => {
 vi.useFakeTimers(); vi.setSystemTime(0)
 let cursors: BulkCursors = {}; let clock = 0; const starts: number[] = []
 const sleepers: { at: number; resolve: () => void }[] = []
 const kinds: BulkClass[] = [...Array<BulkClass>(12).fill('delta'), ...Array<BulkClass>(4).fill('restate'), 'ingest', 'ingest', 'ingest', 'backfill']
 const fetcher = vi.fn(async () => { starts.push(Date.now()); return new Response(null, { status: 202 }) }) as unknown as typeof fetch
 const reserve = vi.fn(async (kind: BulkClass = 'delta') => { const next = nextBulkSlot(cursors, kind, clock); cursors = next.cursors; return next.retryAt === undefined ? next.slot : { retryAt: next.retryAt } })
 const runs = Array.from({ length: 200 }, (_, index) => {
  const memo = new Map<string, unknown>()
  const step: PaceStep = { run: async (id, fn) => { if (!memo.has(id)) memo.set(id, await fn()); return memo.get(id) }, sleepUntil: (_id, date) => new Promise<void>(resolve => sleepers.push({ at: date.getTime(), resolve })) }
  return runPacedSend(step, `worker:${index}`, id => waitForBulkSlot(step, id, kinds[index % kinds.length], reserve), () => deliverDrovrShadowEvent({ event: event(index), config: { ingestUrl: 'https://example.test/events', apiKey: 'synthetic' }, clampAt: 0, fetcher }), 0, exactClock)
 })
 let finished = false; const done = Promise.all(runs).then(() => { finished = true })
 for (let tick = 0; tick < 30; tick++) await Promise.resolve()
 expect(sleepers).toHaveLength(200)
 // Stall the executor 30 seconds: every overdue durable sleeper resumes together.
 clock = 30000; vi.setSystemTime(clock)
 for (let turn = 0; turn < 2000 && !finished; turn++) {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve()
  if (!sleepers.length) continue
  clock = Math.max(clock, Math.min(...sleepers.map(row => row.at))); vi.setSystemTime(clock)
  const ready = sleepers.filter(row => row.at <= clock)
  for (const row of ready) { sleepers.splice(sleepers.indexOf(row), 1); row.resolve() }
 }
 await done
 expect(starts).toHaveLength(200); expect(reserve.mock.calls.length).toBeGreaterThan(200)
 for (const at of starts) expect(starts.filter(other => other >= at && other <= at + 60000).length).toBeLessThanOrEqual(100)
})
