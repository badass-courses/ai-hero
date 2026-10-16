import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import type { DrovrBatchOutcome } from '@/lib/subscriber-marketing/drovr-shadow-delivery'
import type { DrovrOutboxEntry, DrovrOutboxRow, DrovrOutboxSource } from '@/lib/subscriber-marketing/drovr-outbox'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from '@/lib/subscriber-marketing/drovr-outbox'
import { retainedRetryOutcome, retryEventIdentity, type OwnedRetryEvent } from '@/lib/subscriber-marketing/contact-sync-retry-owned-events'
import type { DrovrContactSyncRetryRequested } from '@/inngest/events/drovr'
const target = 'synthetic-wrapper-target'
const clock = '2026-10-16T00:00:00.000Z'
const mocks = vi.hoisted(() => ({
	rows: new Map<string, DrovrOutboxRow>(),
	deliver: vi.fn(async (_args: { events: DrovrShadowEvent[] }): Promise<DrovrBatchOutcome> => ({ accepted: 1, rejected: 0 })),
	reserve: vi.fn(async () => Date.now()),
	settle: vi.fn(), own: vi.fn(), disposition: vi.fn(), load: vi.fn(), capture: vi.fn(), reject: vi.fn(),
	acknowledge: vi.fn(async () => {}), warn: vi.fn(), park: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-unsubscribe-supersession', async load => ({ ...await load<typeof import('@/lib/subscriber-marketing/drovr-unsubscribe-supersession')>(), closeSupersededUnsubscribesLive: async () => new Map() }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({ config, trigger, handler }) } }))
vi.mock('@/db', () => ({ db: {}, acquireDatabaseConnection: async () => ({ query: async () => [[{ now: Date.now() }]], release: () => {} }) }))
vi.mock('@/env.mjs', () => ({ env: { DROVR_SHADOW_INGEST_URL: 'https://drovr.example.test/events' } }))
vi.mock('@/server/logger', () => ({ log: { warn: mocks.warn } }))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({ deliverBatchOrThrow: mocks.deliver }))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', async load => ({ ...await load<typeof import('@/lib/subscriber-marketing/drovr-shadow-emitter')>(), drovrApiKeyForTenant: () => 'synthetic-test-key' }))
vi.mock('@/lib/subscriber-marketing/drovr-bulk-pace', async load => ({ ...await load<typeof import('@/lib/subscriber-marketing/drovr-bulk-pace')>(), waitForBulkSlot: mocks.reserve }))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({ DrizzleCaptureMarketingRepository: class { async findContactById(id: string) { return { id, email: 'synthetic@example.test', createdAt: new Date(clock), meta: {} } } } }))
vi.mock('@/lib/subscriber-marketing/contact-kit-identity-drizzle', () => ({ findContactKitIdentity: async () => ({ kitSubscriberId: null }) }))
vi.mock('@/lib/subscriber-marketing/contact-profile-version-drizzle', () => ({ createDrizzleContactProfileVersionStore: () => ({ acknowledge: mocks.acknowledge }) }))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({ captureDrovrOutboxLive: mocks.capture, holdDrovrStopsLive: async () => 0, settleDrovrOutboxLive: mocks.settle, rejectDrovrOutboxLive: mocks.reject, drovrOutboxTargetFromEnv: () => 'synthetic-wrapper-target' }))
vi.mock('@/lib/subscriber-marketing/contact-sync-retry-owned-events', async load => ({ ...await load<typeof import('@/lib/subscriber-marketing/contact-sync-retry-owned-events')>(), ownRetryEvents: mocks.own, readRetryDispositionLive: mocks.disposition }))
vi.mock('@/lib/subscriber-marketing/contact-sync-retry-acknowledgement', async load => ({ ...await load<typeof import('@/lib/subscriber-marketing/contact-sync-retry-acknowledgement')>(), retryProofRowsLive: mocks.load }))
vi.mock('@/lib/subscriber-marketing/contact-sync-held-batch-live', () => ({ parkContactSyncRetryLive: mocks.park }))
import { drovrContactSyncRetry, runPacedContactSyncRetry } from './drovr-contact-sync-retry'

function tools() {
	return { run: async <T>(_id: string, action: () => Promise<T>) => action(), sleep: vi.fn(async () => {}), sleepUntil: vi.fn(async () => {}), sendEvent: vi.fn(async (_id: string, _value: unknown) => {}) }
}
function fact(type: 'contact.profile.updated' | 'contact.links.issued' | 'contact.offer.issued' = 'contact.profile.updated'): DrovrShadowEvent {
	const base = { tenantId: 'org-aihero' as const, contactId: 'synthetic-contact', journeyId: 'contact-directory' as const, occurredAt: clock, idempotencyKey: `synthetic:${type}` }
	if (type === 'contact.profile.updated') return { ...base, type, idempotencyKey: 'profile:synthetic-contact:1', payload: { profileVersion: 1, email: 'synthetic@example.test', firstName: null, holds: [] } }
	if (type === 'contact.links.issued') return { ...base, type, payload: { profileVersion: 1, journeyId: 'value-path-skills-course', emailKey: 'synthetic-email', issuedAt: clock, expiresAt: '2027-01-01T00:00:00.000Z', variables: {}, sendTimeFields: [] } }
	return { ...base, type, payload: { profileVersion: 1, journeyId: 'crash-course-evergreen-offer', variables: { pitchCouponId: 'synthetic-coupon', pitchCouponExpiresAt: '2027-01-01T00:00:00.000Z' } } }
}
function request(event: DrovrShadowEvent, extra: Partial<DrovrContactSyncRetryRequested['data']> = {}): DrovrContactSyncRetryRequested['data'] {
	return { items: [{ event, reason: 'event-not-live' }], attempt: 1, firstFailedAt: clock, ...extra }
}
function retain(entry: DrovrOutboxEntry, at: number): DrovrOutboxRow {
	const key = drovrOutboxDedupeKey(target, entry)
	let row = mocks.rows.get(key)
	if (!row) {
		row = { ...structuredClone(entry), id: key, dedupeKey: key, target, status: 'pending', attempts: 0, lastStatus: null, lastError: null, firstFailedAt: new Date(at).toISOString(), nextAttemptAt: clock, lastAttemptAt: null, deliveredAt: null, releasedAt: null, createdAt: clock }
		mocks.rows.set(key, row)
	}
	return row
}
/** Execute real physical retry continuations, not their routing parent.
 * Timed deferrals and derived refreshes remain queued. This is a mocked
 * booking/transport-callback test; actual-fetch cap proof lives separately. */
async function run(data: DrovrContactSyncRetryRequested['data']) {
	const step = tools()
	const queue = [data]
	step.sendEvent.mockImplementation(async (id, value) => {
		const envelope = value as { data?: { stragglerRetry?: typeof data } }
		if (id === 'continue-bounded-retry' && envelope.data?.stragglerRetry) queue.push(envelope.data.stragglerRetry)
	})
	let result: unknown; let physical = 0
	while (queue.length) {
		if (++physical > 32) throw new Error('synthetic continuation traversal exceeded its bound')
		result = await runPacedContactSyncRetry({ event: { data: queue.shift()! }, step: step as unknown as Parameters<typeof runPacedContactSyncRetry>[0]['step'], runId: `synthetic-physical-${physical}`, attempt: 0, maxAttempts: 9 })
	}
	return { step, result, physical }
}
beforeEach(() => {
	vi.clearAllMocks(); mocks.rows.clear(); vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
	mocks.deliver.mockImplementation(async ({ events }) => ({ accepted: events.length, rejected: 0 }))
	mocks.capture.mockImplementation(async (entries: DrovrOutboxEntry[]) => { for (const entry of entries) retain(entry, entry.firstSentAt ? Date.parse(entry.firstSentAt) : Date.parse(clock)); return { status: 'outboxed', count: entries.length } })
	mocks.own.mockImplementation(async (events: DrovrShadowEvent[], source: DrovrOutboxSource, at: number): Promise<OwnedRetryEvent[]> => events.map(event => {
		const row = retain(outboxEntryForEvent(event, source, { sentAt: at }), at)
		return { event: structuredClone(row.body) as DrovrShadowEvent, clampAt: Date.parse(row.firstFailedAt), delivered: row.status === 'delivered', status: row.status, outboxKey: row.dedupeKey }
	}))
	mocks.disposition.mockImplementation(async (record: OwnedRetryEvent) => retainedRetryOutcome(record, [{ key: record.outboxKey, status: mocks.rows.get(record.outboxKey)!.status }]))
	mocks.load.mockImplementation(async (_target: string, keys: string[]) => [...mocks.rows.values()].filter(row => keys.includes(row.dedupeKey)))
	mocks.settle.mockImplementation(async (entries: DrovrOutboxEntry[]) => { for (const entry of entries) { const row = mocks.rows.get(drovrOutboxDedupeKey(target, entry)); if (row && ['pending', 'deferred'].includes(row.status)) { row.status = 'delivered'; row.deliveredAt = clock } } return entries.length })
	mocks.reject.mockImplementation(async (entries: DrovrOutboxEntry[]) => { for (const entry of entries) mocks.rows.get(drovrOutboxDedupeKey(target, entry))!.status = 'rejected' })
	mocks.park.mockImplementation(async () => { throw new Error('synthetic wrapper unexpectedly failed fresh whole-batch proof') })
})
afterEach(() => { vi.unstubAllEnvs() })
describe('real retry routing and physical wrapper', () => {
	it('routing a capped request publishes unchanged work and never claims physical delivery', async () => {
		const data = request(fact(), { paceClass: 'delta' }); const step = tools()
		const parent = drovrContactSyncRetry as unknown as { handler: (args: unknown) => Promise<unknown> }
		expect(await parent.handler({ event: { id: 'synthetic-parent', data }, step, runId: 'synthetic-router', attempt: 0, maxAttempts: 9 })).toMatchObject({ status: 'routed', paceClass: 'delta' })
		expect(step.sendEvent).toHaveBeenCalledWith('route-capped-retry', expect.objectContaining({ data: expect.objectContaining({ stragglerRetry: expect.objectContaining(data) }) }))
		expect(mocks.deliver).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.acknowledge).not.toHaveBeenCalled()
	})
	it('keeps a genuine coupon unpaced, but reserves for a bump offer on its originating class', async () => {
		await run(request(fact('contact.offer.issued')))
		expect(mocks.reserve).not.toHaveBeenCalled()
		// A different full scope avoids reusing the genuine offer's receipt.
		await run(request({ ...fact('contact.offer.issued'), idempotencyKey: 'synthetic:capped-offer' }, { paceClass: 'backfill' }))
		expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'backfill')
	})
	it('bounded physical runs birth once for eight cold links, reserve for each callback, and ACK only after all finish', async () => {
		let born = false
		mocks.deliver.mockImplementation(async ({ events }) => {
			if (events[0]!.type === 'contact.created') { born = true; return { accepted: 1, rejected: 0 } }
			return born ? { accepted: events.length, rejected: 0 } : { accepted: 0, rejected: 0, deferred: events.map(event => ({ event, reason: 'cold-start-unhandled' })) }
		})
		const authority = retain(outboxEntryForEvent(fact(), 'bulkDelta'), Date.parse(clock)); authority.status = 'delivered'; authority.deliveredAt = clock
		const items = Array.from({ length: 8 }, (_, index) => ({ event: { ...fact('contact.links.issued'), idempotencyKey: `links:synthetic-contact:value-path-skills-course:slot-${index}:v1` }, reason: 'cold-start-unhandled' as const }))
		const result = await run({ items, attempt: 1, firstFailedAt: clock, paceClass: 'delta', acknowledge: { contactId: 'synthetic-contact', profileVersion: 1 } })
		expect(result.physical).toBe(8)
		expect(mocks.deliver.mock.calls.filter(([args]) => args.events[0]!.type === 'contact.created')).toHaveLength(1)
		// First run: refused link + birth + retry. Seven later runs: one
		// already-born link each. All callbacks book their own reservation.
		expect(mocks.deliver).toHaveBeenCalledTimes(10); expect(mocks.reserve).toHaveBeenCalledTimes(10)
		expect(mocks.acknowledge).toHaveBeenCalledOnce(); expect(mocks.acknowledge).toHaveBeenCalledWith('synthetic-contact', 1)
		for (const item of items) expect(mocks.rows.get(drovrOutboxDedupeKey(target, outboxEntryForEvent(item.event, 'bulkDelta')))?.status).toBe('delivered')
	})
	it('a refusal beyond two hours is rescheduled unchanged in its original class, not discarded or acknowledged', async () => {
		const event = fact()
		mocks.deliver.mockResolvedValue({ accepted: 0, rejected: 0, deferred: [{ event, reason: 'event-not-live' }] })
		const { step, result } = await run(request(event, { attempt: 48, paceClass: 'delta' }))
		expect(result).toMatchObject({ status: 'rescheduled', attempt: 49 })
		expect(step.sendEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: expect.objectContaining({ stragglerRetry: expect.objectContaining({ attempt: 49, items: [{ event, reason: 'event-not-live' }], paceClass: 'delta', firstFailedAt: clock }) }) }))
		expect(mocks.acknowledge).not.toHaveBeenCalled()
	})
})
