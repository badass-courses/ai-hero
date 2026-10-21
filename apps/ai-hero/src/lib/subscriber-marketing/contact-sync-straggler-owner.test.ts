import { describe, expect, it, vi } from 'vitest'
import {
	contactSyncRetryRequest,
	contactSyncStarterRequests,
	runContactSyncStragglerRetry,
} from './contact-sync-straggler-retry'
import {
	claimStragglerOwner,
	runOwnedStragglerRetry,
	stragglerOwnerKey,
	STRAGGLER_PARK_AFTER_MS,
	type StragglerOwner,
	type StragglerOwnerStore,
} from './contact-sync-straggler-owner'
import type { DrovrContactSyncRetryRequested } from '@/inngest/events/drovr'
import type {
	DeferredDrovrEvent,
	DrovrBatchOutcome,
} from './drovr-shadow-delivery'
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const start = Date.parse('2032-01-01T00:00:00Z')
function item(contactId = 'synthetic-owner'): DeferredDrovrEvent {
	return {
		reason: 'event-not-live',
		event: {
			tenantId: 'org-aihero',
			contactId,
			journeyId: 'contact-directory',
			type: 'contact.profile.updated',
			idempotencyKey: `profile:${contactId}:1`,
			occurredAt: '2031-12-31T00:00:00Z',
			payload: {
				profileVersion: 1,
				email: 'synthetic@example.test',
				firstName: null,
				holds: [],
			},
		},
	}
}
/** Atomic in-memory PORT only, not a MySQL lock/concurrency proof. */
function fixture() {
	let now = start
	const owners = new Map<string, StragglerOwner>()
	const store: StragglerOwnerStore = {
		async update(key, change) {
			const next = change(owners.get(key), now)
			owners.set(key, structuredClone(next.owner))
			return structuredClone(next.value)
		},
	}
	const deliver = vi.fn(
		async (events: unknown[]): Promise<DrovrBatchOutcome> => ({
			accepted: 0,
			rejected: 0,
			deferred: events.map((event) => ({
				reason: 'event-not-live' as const,
				event: event as DeferredDrovrEvent['event'],
			})),
		}),
	)
	const birth = vi.fn(async () => {}),
		acknowledge = vi.fn(async () => {}),
		warn = vi.fn(),
		parked = vi.fn(async (_fields: Record<string, unknown>) => {}),
		joined = vi.fn(async (_counts: Record<string, number>) => {})
	function invocation(event: DrovrContactSyncRetryRequested) {
		const cache = new Map<string, unknown>(),
			sent: DrovrContactSyncRetryRequested[] = []
		const step = {
			async run<T>(id: string, callback: () => Promise<T>) {
				if (!cache.has(id)) cache.set(id, await callback())
				return structuredClone(cache.get(id))
			},
			async sendEvent(_id: string, payload: unknown) {
				sent.push(payload as DrovrContactSyncRetryRequested)
				return {}
			},
		}
		const execute = () =>
			runOwnedStragglerRetry({
				event,
				step,
				store,
				run: runContactSyncStragglerRetry,
				env: {
					AIH_DROVR_PROFILE_SYNC: 'true',
					DROVR_SHADOW_INGEST_URL: 'https://synthetic.example.test/events',
					DROVR_SHADOW_API_KEY: 'synthetic',
				},
				now: () => now,
				deliver,
				birth,
				acknowledge,
				warn,
				parked,
				joined,
			})
		return { execute, sent, cache }
	}
	return {
		owners,
		store,
		deliver,
		birth,
		acknowledge,
		warn,
		parked,
		joined,
		invocation,
		at: (value: number) => {
			now = value
		},
	}
}
const starter = (contactId = 'synthetic-owner', time = start) =>
	contactSyncStarterRequests([item(contactId)], time, {
		contactId,
		profileVersion: 1,
	})[0]!

describe('new straggler starter ownership (no-SQL ports)', () => {
	it('joins concurrent and daily starters per contact without resetting original age', async () => {
		const h = fixture(),
			a = h.invocation(starter()),
			b = h.invocation(starter())
		const results = await Promise.all([a.execute(), b.execute()])
		expect(results.map((x) => x.status).sort()).toEqual([
			'joined',
			'rescheduled',
		])
		expect(h.deliver).toHaveBeenCalledTimes(1)
		const original = structuredClone([...h.owners.values()][0])
		h.at(start + 24 * 3600000)
		expect(
			await h
				.invocation(starter('synthetic-owner', start + 24 * 3600000))
				.execute(),
		).toEqual({ status: 'joined' })
		expect([...h.owners.values()][0]).toEqual(original)
		expect(h.deliver).toHaveBeenCalledTimes(1)
	})
	it('separate contacts have separate owners, no address in the key', async () => {
		const h = fixture()
		await Promise.all(
			['one', 'two'].map((id) => h.invocation(starter(id)).execute()),
		)
		expect(h.owners.size).toBe(2)
		expect(h.deliver).toHaveBeenCalledTimes(2)
		expect(stragglerOwnerKey('one')).toMatch(/^straggler-owner:[a-f0-9]{64}$/)
	})
	it('continuations keep generation, original body/clock and their distinct attempt IDs', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		const next = a.sent[0]!
		expect(next.data.attempt).toBe(2)
		expect(next.data.items).toEqual([item()])
		expect(next.data.acknowledge).toEqual(starter().data.acknowledge)
		expect(next.data.stragglerOwner).toMatchObject({
			protocol: 1,
			startedAt: start,
		})
		expect(next.data.stragglerOwner?.generation).toBeTypeOf('string')
		h.at(start + 3 * 3600000)
		const b = h.invocation(next)
		await b.execute()
		expect(h.deliver).toHaveBeenCalledTimes(2)
		expect(b.sent[0]!.data.attempt).toBe(3)
		expect(b.sent[0]!.data.stragglerOwner).toEqual(next.data.stragglerOwner)
		expect(b.sent[0]!.data.items).toEqual(next.data.items)
		expect((b.sent[0] as { id?: string }).id).not.toEqual(
			(next as { id?: string }).id,
		)
	})
	it('duplicate new-protocol continuation loses its CAS and cannot send or schedule again', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		const b = h.invocation(a.sent[0]!),
			c = h.invocation(a.sent[0]!)
		await Promise.all([b.execute(), c.execute()])
		expect(h.deliver).toHaveBeenCalledTimes(2)
		expect(b.sent.length + c.sent.length).toBe(1)
	})
	it('parks at exactly seven original calendar days before HTTP/ACK/schedule and logs only safe fields', async () => {
		const h = fixture(),
			original = starter(),
			bytes = JSON.stringify(original),
			a = h.invocation(original)
		await a.execute()
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		const b = h.invocation(a.sent[0]!)
		expect(await b.execute()).toEqual({ status: 'parked' })
		expect(h.deliver).toHaveBeenCalledTimes(1)
		expect(b.sent).toHaveLength(0)
		expect(h.acknowledge).not.toHaveBeenCalled()
		expect(h.parked).toHaveBeenCalledTimes(1)
		const fields = h.parked.mock.calls[0]![0] as Record<string, unknown>
		expect(Object.keys(fields).sort()).toEqual(
			[
				'alertId',
				'contactId',
				'refusalCode',
				'eventTypes',
				'attempts',
				'firstAttemptAt',
				'parkedAt',
			].sort(),
		)
		expect(fields).toMatchObject({
			contactId: 'synthetic-owner',
			refusalCode: 'event-not-live',
			attempts: 1,
			firstAttemptAt: new Date(start).toISOString(),
			parkedAt: new Date(start + STRAGGLER_PARK_AFTER_MS).toISOString(),
		})
		expect(JSON.stringify(fields)).not.toContain('example.test')
		expect(JSON.stringify(original)).toBe(bytes)
		await h
			.invocation(starter('synthetic-owner', start + STRAGGLER_PARK_AFTER_MS))
			.execute()
		expect(h.parked).toHaveBeenCalledTimes(1)
		expect([...h.owners.values()][0]!.state).toBe('parked')
	})
	it('does not park at seven 2h attempts or at six calendar days', async () => {
		const h = fixture()
		let event: DrovrContactSyncRetryRequested = starter()
		for (let attempt = 1; attempt <= 7; attempt++) {
			h.at(start + (attempt - 1) * 2 * 3600000)
			const a = h.invocation(event)
			await a.execute()
			event = a.sent[0]!
		}
		h.at(start + STRAGGLER_PARK_AFTER_MS - 1)
		expect((await h.invocation(event).execute()).status).toBe('rescheduled')
		expect(h.parked).not.toHaveBeenCalled()
	})
	it('ACK completion finishes only the claimed generation and allows a subsequent new chain', async () => {
		const h = fixture()
		h.deliver.mockResolvedValueOnce({ accepted: 1, rejected: 0, deferred: [] })
		await h.invocation(starter()).execute()
		const first = [...h.owners.values()][0]!
		expect(first.state).toBe('complete')
		expect(h.acknowledge).toHaveBeenCalledWith('synthetic-owner', 1)
		await h.invocation(starter()).execute()
		expect([...h.owners.values()][0]!.generation).not.toBe(first.generation)
	})
	it('a stale generation cannot send, ACK or mutate the new owner', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		const before = structuredClone([...h.owners.values()][0])
		const event = structuredClone(a.sent[0]!)
		event.data.stragglerOwner!.generation = 'stale-generation'
		expect(await h.invocation(event).execute()).toEqual({ status: 'stale' })
		expect([...h.owners.values()][0]).toEqual(before)
		expect(h.deliver).toHaveBeenCalledTimes(1)
		expect(h.acknowledge).not.toHaveBeenCalled()
	})
	it('legacy queued events keep old steps, continuing IDs and the old warn boundary', async () => {
		const h = fixture(),
			a = h.invocation(contactSyncRetryRequest([item()], 53, start))
		await a.execute()
		expect(h.owners.size).toBe(0)
		expect([...a.cache.keys()]).toEqual(['now', 'deliver'])
		expect(a.sent[0]!.data.attempt).toBe(54)
		expect(a.sent[0]!.data.stragglerOwner).toBeUndefined()
		expect(h.warn).toHaveBeenCalledOnce()
	})
	it('new-protocol attempts do not repeatedly emit the legacy outside-step warning', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		const event = a.sent[0]!,
			owner = [...h.owners.values()][0]!
		h.owners.set(stragglerOwnerKey('synthetic-owner'), { ...owner, next: 53 })
		event.data.attempt = 53
		await h.invocation(event).execute()
		expect(h.warn).not.toHaveBeenCalled()
	})
	it('splits new multi-contact starters without changing the original membership or ACK scope', () => {
		const items = [item('one'), item('two')],
			before = JSON.stringify(items)
		const requests = contactSyncStarterRequests(items, start, {
			contactId: 'two',
			profileVersion: 1,
		})
		expect(requests).toHaveLength(2)
		expect(requests[0]!.data.items).toEqual([items[0]])
		expect(requests[0]!.data.acknowledge).toBeUndefined()
		expect(requests[1]!.data.acknowledge?.contactId).toBe('two')
		expect(JSON.stringify(items)).toBe(before)
	})
	it('fresh actual deliver checks seven-day expiry even with a memoized claim and now', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		h.deliver.mockRejectedValueOnce(
			new Error('synthetic transient before checkpoint'),
		)
		await expect(a.execute()).rejects.toThrow('synthetic transient')
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		expect(await a.execute()).toEqual({ status: 'parked' })
		expect(h.deliver).toHaveBeenCalledTimes(1)
		expect(a.sent).toHaveLength(0)
		expect(h.parked).toHaveBeenCalledOnce()
	})
	it('wakes at the deadline rather than scheduling a retry past seven days', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		h.at(start + STRAGGLER_PARK_AFTER_MS - 1)
		const b = h.invocation(a.sent[0]!)
		await b.execute()
		expect(
			(b.sent[0] as DrovrContactSyncRetryRequested & { ts: number }).ts,
		).toBe(start + STRAGGLER_PARK_AFTER_MS)
	})
	it('park logging retry has a stable alert id and never starts transport again', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		const b = h.invocation(a.sent[0]!)
		h.parked.mockRejectedValueOnce(new Error('synthetic log sink failure'))
		await expect(b.execute()).rejects.toThrow('log sink')
		expect(await b.execute()).toEqual({ status: 'parked' })
		expect(h.parked.mock.calls[0]![0]).toEqual(h.parked.mock.calls[1]![0])
		expect(h.deliver).toHaveBeenCalledTimes(1)
	})
	it('PR1 explicitly skips unretained new membership while the contact is active', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		const joiner = starter()
		joiner.data.items[0]!.event.idempotencyKey += ':new'
		expect(await h.invocation(joiner).execute()).toEqual({ status: 'joined' })
		expect(h.deliver).toHaveBeenCalledTimes(1)
		// NOT durable joined debt: documented PR2/release gap, not a false ACK.
		expect(h.acknowledge).not.toHaveBeenCalled()
	})
	it('source-off wakes retain the generation, age, body and debt without HTTP', async () => {
		const h = fixture(),
			original = starter(),
			sent: unknown[] = []
		const result = await runOwnedStragglerRetry({
			event: original,
			store: h.store,
			run: runContactSyncStragglerRetry,
			step: {
				run: async (_id, callback) => callback(),
				sendEvent: async (_id, payload) => {
					sent.push(payload)
				},
			},
			env: {},
			now: () => start,
			deliver: h.deliver,
			birth: h.birth,
			acknowledge: h.acknowledge,
			warn: h.warn,
			parked: h.parked,
		})
		expect(result.status).toBe('rescheduled')
		expect(h.deliver).not.toHaveBeenCalled()
		expect((sent[0] as DrovrContactSyncRetryRequested).data).toMatchObject({
			items: original.data.items,
			attempt: 2,
			stragglerOwner: { protocol: 1, startedAt: start },
		})
	})
	it('an address cannot become the contactId alert field', async () => {
		const h = fixture()
		await expect(
			h.invocation(starter('synthetic@example.test')).execute(),
		).rejects.toThrow('exactly one contact')
		expect(h.parked).not.toHaveBeenCalled()
		expect(h.owners.size).toBe(0)
	})
	it('same/different/unknown fingerprint telemetry has counts only; different is a gap-candidate upper bound', async () => {
		const h = fixture()
		await h.invocation(starter()).execute()
		await h.invocation(starter()).execute()
		expect(h.joined.mock.calls[0]![0]).toEqual({
			starters: 1,
			incomingKeys: 1,
			unchangedMembership: 1,
			changedMembershipCandidate: 0,
			unknownMembership: 0,
			parkedOwners: 0,
		})
		const changed = starter()
		changed.data.items[0]!.event.idempotencyKey += ':candidate'
		await h.invocation(changed).execute()
		expect(h.joined.mock.calls[1]![0]).toMatchObject({
			unchangedMembership: 0,
			changedMembershipCandidate: 1,
			unknownMembership: 0,
		})
		const key = stragglerOwnerKey('synthetic-owner'),
			owner = { ...h.owners.get(key)! }
		delete owner.membershipDigest
		h.owners.set(key, owner)
		await h.invocation(starter()).execute()
		expect(h.joined.mock.calls[2]![0]).toMatchObject({
			unchangedMembership: 0,
			changedMembershipCandidate: 0,
			unknownMembership: 1,
		})
		for (const [counts] of h.joined.mock.calls)
			expect(
				Object.values(counts).every((value) => typeof value === 'number'),
			).toBe(true)
	})
	it('a subset also differs: telemetry must not claim a genuinely new key', async () => {
		const h = fixture(),
			original = starter(),
			second = item()
		second.event.idempotencyKey += ':second'
		original.data.items.push(second)
		await h.invocation(original).execute()
		await h.invocation(starter()).execute()
		expect(h.joined.mock.calls[0]![0]).toMatchObject({
			changedMembershipCandidate: 1,
			incomingKeys: 1,
		})
		expect(h.acknowledge).not.toHaveBeenCalled()
	})
	it('memoized deliver denial survives JSON serialization and alert retry without Error identity', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		h.deliver.mockRejectedValueOnce(new Error('synthetic transient'))
		await expect(a.execute()).rejects.toThrow('synthetic transient')
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		h.parked.mockRejectedValueOnce(new Error('synthetic alert sink failure'))
		await expect(a.execute()).rejects.toThrow('alert sink')
		const saved = JSON.parse(JSON.stringify(a.cache.get('deliver')))
		expect(saved).toMatchObject({
			kind: 'owner-stopped',
			decision: { status: 'parked' },
		})
		a.cache.set('deliver', saved)
		expect(await a.execute()).toEqual({ status: 'parked' })
		expect(h.parked.mock.calls[0]![0]).toEqual(h.parked.mock.calls[1]![0])
		expect(h.deliver).toHaveBeenCalledTimes(1)
		expect(a.sent).toHaveLength(0)
	})
	it('redelivery after birth gets its own fresh deadline check', async () => {
		const h = fixture(),
			event = starter()
		event.data.items[0]!.reason = 'cold-start-unhandled'
		h.deliver.mockResolvedValueOnce({
			accepted: 0,
			rejected: 0,
			deferred: event.data.items,
		})
		h.birth.mockImplementationOnce(async () => {
			h.at(start + STRAGGLER_PARK_AFTER_MS)
		})
		const a = h.invocation(event)
		expect(await a.execute()).toEqual({ status: 'parked' })
		expect(h.birth).toHaveBeenCalledTimes(1)
		expect(h.deliver).toHaveBeenCalledTimes(1)
		expect(h.acknowledge).not.toHaveBeenCalled()
		expect(a.sent).toHaveLength(0)
		expect(a.cache.get('redeliver-after-birth')).toMatchObject({
			kind: 'owner-stopped',
		})
	})
	it.each([null, false, 0])(
		'present malformed marker %s never falls back to legacy delivery',
		async (marker) => {
			const h = fixture(),
				event = starter()
			event.data.stragglerOwner = marker as unknown as NonNullable<
				DrovrContactSyncRetryRequested['data']['stragglerOwner']
			>
			await expect(h.invocation(event).execute()).rejects.toThrow(
				'malformed protocol marker',
			)
			expect(h.deliver).not.toHaveBeenCalled()
			expect(h.owners.size).toBe(0)
		},
	)
	it('rejects malformed owner inputs before sending or claiming', () => {
		expect(() =>
			claimStragglerOwner(
				undefined,
				{ protocol: 1, startedAt: start + 1 },
				1,
				start,
			),
		).toThrow('clock')
		expect(() =>
			claimStragglerOwner(
				undefined,
				{ protocol: 1, startedAt: start, generation: 'lost' },
				2,
				start,
			),
		).toThrow('original owner')
	})
})
