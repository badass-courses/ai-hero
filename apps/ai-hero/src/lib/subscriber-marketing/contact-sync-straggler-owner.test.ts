import { describe, expect, it, vi } from 'vitest'
import { NonRetriableError } from 'inngest'
import { deliverHoldingUnsubscribed } from './drovr-straggler-hold'
import type { ContactSyncRetryReceipt } from './contact-sync-straggler-retry'
import {
	contactSyncRetryRequest,
	contactSyncStarterRequests,
	runContactSyncStragglerRetry,
} from './contact-sync-straggler-retry'
import {
	claimStragglerOwner,
	isStragglerParkCode,
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
const STRAGGLER_DEADLINE_GRACE_MS = 60_000
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
	let sequence = 0
	const owners = new Map<string, StragglerOwner>()
	const store: StragglerOwnerStore = {
		async update(key, change) {
			const next = change(owners.get(key), now)
			owners.set(key, structuredClone(next.owner))
			return structuredClone(next.value)
		},
	}
	const deliver = vi.fn(
		async (
			events: DeferredDrovrEvent['event'][],
		): Promise<DrovrBatchOutcome> => ({
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
	function invocation(
		event: DrovrContactSyncRetryRequested,
		run: typeof runContactSyncStragglerRetry = runContactSyncStragglerRetry,
	) {
		const runId = `synthetic-run-${++sequence}`
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
				runId,
				step,
				store,
				run,
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
		return { execute, sent, cache, runId }
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
		// Unlike a new starter batch, the unmarked continuation stays one
		// event object with the exact legacy ID, body, clock and no marker.
		expect(Array.isArray(a.sent[0])).toBe(false)
		expect(a.sent).toEqual([contactSyncRetryRequest([item()], 54, start)])
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
		).toBe(start + STRAGGLER_PARK_AFTER_MS + STRAGGLER_DEADLINE_GRACE_MS)
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
			runId: 'synthetic-source-off',
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
	it('dead chain with no continuation is parked and alerted by a starter at the original deadline', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		h.deliver.mockRejectedValueOnce(
			new NonRetriableError('synthetic dead chain'),
		)
		await expect(a.execute()).rejects.toThrow('synthetic dead chain')
		expect(a.sent).toHaveLength(0)
		const original = structuredClone([...h.owners.values()][0]!)
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		const joining = starter('synthetic-owner', start + STRAGGLER_PARK_AFTER_MS)
		joining.data.items[0]!.event.idempotencyKey += ':unrelated'
		const b = h.invocation(joining)
		expect(await b.execute()).toEqual({ status: 'parked' })
		expect([...h.owners.values()][0]).toMatchObject({
			...original,
			state: 'parked',
		})
		expect(h.deliver).toHaveBeenCalledOnce()
		expect(b.sent).toHaveLength(0)
		expect(h.acknowledge).not.toHaveBeenCalled()
		expect(h.parked.mock.calls[0]![0]).toEqual({
			alertId: `straggler-parked:${original.generation}`,
			contactId: 'synthetic-owner',
			refusalCode: 'owner-expired',
			eventTypes: [],
			attempts: 1,
			firstAttemptAt: new Date(start).toISOString(),
			parkedAt: new Date(start + STRAGGLER_PARK_AFTER_MS).toISOString(),
		})
		await h.invocation(joining).execute()
		expect(h.parked).toHaveBeenCalledOnce()
		expect(h.joined).toHaveBeenLastCalledWith(
			expect.objectContaining({ parkedOwners: 1 }),
		)
	})
	it('a future non-delivered terminal receipt completes the owner without an ACK', async () => {
		const h = fixture(),
			terminal = { status: 'held-unsubscribed' }
		// Deliberately injected FUTURE status, not a current legacy wire/status.
		const a = h.invocation(
			starter(),
			async () => terminal as unknown as ContactSyncRetryReceipt,
		)
		expect(await a.execute()).toEqual(terminal)
		expect([...h.owners.values()][0]!.state).toBe('complete')
		expect(h.acknowledge).not.toHaveBeenCalled()
		expect(a.sent).toHaveLength(0)
	})
	it('actual unsubscribed-hold terminal completes with rejected items and no send or ACK', async () => {
		const h = fixture(),
			send = vi.fn()
		h.deliver.mockImplementation(
			deliverHoldingUnsubscribed({
				isUnsubscribed: async () => true,
				warn: h.warn,
				send,
			}),
		)
		expect(await h.invocation(starter()).execute()).toEqual({
			status: 'delivered',
			accepted: 0,
			rejected: 1,
		})
		expect(send).not.toHaveBeenCalled()
		expect(h.acknowledge).not.toHaveBeenCalled()
		const first = [...h.owners.values()][0]!
		expect(first.state).toBe('complete')
		await h.invocation(starter()).execute()
		expect([...h.owners.values()][0]!.generation).not.toBe(first.generation)
	})
	it.each([1, 5 * 60_000])(
		'normalizes app birth clock ahead by %i ms only once without changing event bytes',
		async (ahead) => {
			const h = fixture(),
				event = starter('synthetic-owner', start + ahead)
			const bytes = JSON.stringify(event)
			const a = h.invocation(event)
			await a.execute()
			const owner = [...h.owners.values()][0]!
			expect(owner.startedAt).toBe(start)
			expect(owner.deadline).toBe(start + STRAGGLER_PARK_AFTER_MS)
			expect(a.sent[0]!.data.stragglerOwner!.startedAt).toBe(start)
			expect(JSON.stringify(event)).toBe(bytes)
			expect(h.parked).not.toHaveBeenCalled()
			const before = structuredClone(owner)
			await h
				.invocation(starter('synthetic-owner', start + 24 * 3600_000))
				.execute()
			expect([...h.owners.values()][0]).toEqual(before)
		},
	)
	it('excess birth clock skew commits quarantine and alerts before failing non-retriably', async () => {
		const h = fixture(),
			a = h.invocation(starter('synthetic-owner', start + 5 * 60_000 + 1))
		await expect(a.execute()).rejects.toBeInstanceOf(NonRetriableError)
		const owner = [...h.owners.values()][0]!
		expect(owner).toMatchObject({ state: 'parked', startedAt: start, next: 1 })
		expect(h.deliver).not.toHaveBeenCalled()
		expect(h.acknowledge).not.toHaveBeenCalled()
		expect(a.sent).toHaveLength(0)
		expect(h.parked.mock.calls[0]![0]).toEqual({
			alertId: `straggler-parked:${owner.generation}`,
			contactId: 'synthetic-owner',
			refusalCode: 'owner-clock-skew',
			eventTypes: ['contact.profile.updated'],
			attempts: 0,
			firstAttemptAt: new Date(start).toISOString(),
			parkedAt: new Date(start).toISOString(),
		})
		await expect(a.execute()).rejects.toBeInstanceOf(NonRetriableError)
		expect(h.parked).toHaveBeenCalledOnce()
	})
	it('excess-skew alert retry retains its committed quarantine and stable seven fields', async () => {
		const h = fixture(),
			a = h.invocation(starter('synthetic-owner', start + 6 * 60_000))
		h.parked.mockRejectedValueOnce(new Error('synthetic alert failure'))
		await expect(a.execute()).rejects.toThrow('synthetic alert failure')
		expect([...h.owners.values()][0]!.state).toBe('parked')
		await expect(a.execute()).rejects.toBeInstanceOf(NonRetriableError)
		expect(h.parked.mock.calls[0]![0]).toEqual(h.parked.mock.calls[1]![0])
		expect(h.deliver).not.toHaveBeenCalled()
	})
	it.each([
		[
			'reschedule',
			{ name: 'unrelated/event', id: 'untouched', data: { value: 1 } },
		],
		['reschedule', [{ name: 'unrelated/event', data: {} }]],
		['different-step', null],
	])('passes unrelated sends through unchanged: %s', async (id, payload) => {
		const h = fixture()
		const a = h.invocation(starter(), async (args) => {
			await args.step.sendEvent(id as string, payload)
			return { status: 'delivered', accepted: 0, rejected: 0 }
		})
		await a.execute()
		expect(a.sent[0]).toBe(payload)
	})
	it.each([
		undefined,
		null,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
		0.5,
		'not-a-clock',
	])(
		'rejects a missing or invalid continuation timestamp %s before sending',
		async (ts) => {
			const h = fixture()
			const a = h.invocation(starter(), async (args) => {
				await args.step.sendEvent('reschedule', {
					...contactSyncRetryRequest([item()], 2, start),
					ts,
				})
				return { status: 'rescheduled', deferred: 1, attempt: 2 }
			})
			await expect(a.execute()).rejects.toThrow(
				'invalid continuation clock or attempt',
			)
			expect(a.sent).toHaveLength(0)
		},
	)
	it('new starter IDs cannot collide with any legacy attempt/digest prefix', () => {
		const items = [item()],
			legacy = contactSyncRetryRequest(items, 1, start),
			next = starter()
		expect(legacy.id).toMatch(/^contact-sync-retry:1:[a-f0-9]{64}$/)
		expect(next.id).toBe(`contact-sync-starter:${legacy.id}`)
		expect(next.id.startsWith('contact-sync-retry:')).toBe(false)
		expect(next.id.startsWith('contact-sync-owned:')).toBe(false)
		expect(next.id).not.toBe(contactSyncRetryRequest(items, 2, start).id)
	})
	it('opaque contact IDs of any practical length always hash to an 80-character ASCII name', () => {
		for (const contactId of ['x', 'x'.repeat(255), 'x'.repeat(100_000)]) {
			const key = stragglerOwnerKey(contactId)
			expect(key).toMatch(/^straggler-owner:[a-f0-9]{64}$/)
			expect(key).toHaveLength(80)
		}
	})
	it.each(['starter', 'continuation'])(
		'committed %s claim re-executes after lost step state with the same run and one deliver',
		async (kind) => {
			const h = fixture()
			let event = starter()
			if (kind === 'continuation') {
				const seed = h.invocation(event)
				await seed.execute()
				event = seed.sent[0]! as ReturnType<typeof starter>
				h.deliver.mockClear()
			}
			let executions = 0
			const a = h.invocation(event, async (args) => {
				if (executions++ === 0)
					throw new Error('synthetic committed claim result lost')
				return runContactSyncStragglerRetry(args)
			})
			await expect(a.execute()).rejects.toThrow('claim result lost')
			const owner = structuredClone([...h.owners.values()][0]!)
			expect(h.deliver).not.toHaveBeenCalled()
			a.cache.clear()
			expect((await a.execute()).status).toBe('rescheduled')
			expect(owner.claimedBy).toBe(a.runId)
			expect(a.cache.get('straggler-owner-claim')).toMatchObject({
				status: 'claimed',
			})
			expect([...h.owners.values()][0]).toEqual(owner)
			expect(h.deliver).toHaveBeenCalledOnce()
			expect(a.sent).toHaveLength(1)
		},
	)
	it.each([
		['different-step', contactSyncRetryRequest([item()], 2, start)],
		['reschedule', [contactSyncRetryRequest([item()], 2, start)]],
		[
			'different-step',
			[
				{ name: 'unrelated/event' },
				contactSyncRetryRequest([item()], 2, start),
			],
		],
	])(
		'fails closed when a retry escapes the single owned envelope: %s',
		async (id, payload) => {
			const h = fixture(),
				a = h.invocation(starter(), async (args) => {
					await args.step.sendEvent(id as string, payload)
					return { status: 'delivered', accepted: 0, rejected: 0 }
				})
			await expect(a.execute()).rejects.toThrow(
				'unexpected retry event envelope',
			)
			expect(a.sent).toHaveLength(0)
		},
	)
	it('a committed park with lost step result is recovered and alerted, not swallowed as stale', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		h.deliver.mockRejectedValueOnce(new Error('synthetic first delivery fault'))
		await expect(a.execute()).rejects.toThrow('delivery fault')
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		h.parked.mockRejectedValueOnce(new Error('synthetic alert failed'))
		await expect(a.execute()).rejects.toThrow('alert failed')
		const park = structuredClone([...h.owners.values()][0]!.park)
		a.cache.delete('deliver')
		h.at(start + STRAGGLER_PARK_AFTER_MS + 1000)
		expect(await a.execute()).toEqual({ status: 'parked' })
		expect(h.parked.mock.calls[0]![0]).toEqual(h.parked.mock.calls[1]![0])
		expect([...h.owners.values()][0]!.park).toEqual({ ...park, alerted: true })
		expect(h.deliver).toHaveBeenCalledOnce()
	})
	it('a later continuation recovers an unaccepted park alert from persisted provenance', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		h.at(start + STRAGGLER_PARK_AFTER_MS)
		h.parked.mockRejectedValueOnce(new Error('synthetic exhausted alert'))
		await expect(h.invocation(a.sent[0]!).execute()).rejects.toThrow(
			'exhausted alert',
		)
		const later = a.sent[0]!
		later.data.items[0]!.event.idempotencyKey += ':unrelated-retry'
		h.at(start + STRAGGLER_PARK_AFTER_MS + 10_000)
		expect(await h.invocation(later).execute()).toEqual({ status: 'parked' })
		expect(h.parked.mock.calls[0]![0]).toEqual(h.parked.mock.calls[1]![0])
		expect([...h.owners.values()][0]!.park?.alerted).toBe(true)
		await h.invocation(later).execute()
		expect(h.parked).toHaveBeenCalledTimes(2)
	})
	it('boundary wake with DB still behind the deadline quarantines once without a POST hot loop', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		await a.execute()
		h.at(start + STRAGGLER_PARK_AFTER_MS - 1)
		const b = h.invocation(a.sent[0]!)
		await b.execute()
		const before = h.deliver.mock.calls.length,
			c = h.invocation(b.sent[0]!)
		await expect(c.execute()).rejects.toBeInstanceOf(NonRetriableError)
		expect(h.deliver).toHaveBeenCalledTimes(before)
		expect(c.sent).toHaveLength(0)
		expect(h.parked).toHaveBeenLastCalledWith(
			expect.objectContaining({ refusalCode: 'owner-clock-skew' }),
		)
		expect([...h.owners.values()][0]!.deadline).toBe(
			start + STRAGGLER_PARK_AFTER_MS,
		)
	})
	it('bounded park provenance and accepted-alert flag fit the existing cursor even with a maximum claimant', () => {
		const source = {
			code: 'event-not-live',
			types: Array.from(
				{ length: 40 },
				(_, i) => `synthetic.${'x'.repeat(60)}.${i}`,
			),
		}
		const first = claimStragglerOwner(
			undefined,
			{ protocol: 1, startedAt: start },
			1,
			start,
			'r'.repeat(64),
			'f'.repeat(64),
			source,
		)
		const parked = claimStragglerOwner(
			first.owner,
			{ protocol: 1, startedAt: start, generation: first.owner.generation },
			2,
			start + STRAGGLER_PARK_AFTER_MS,
			's'.repeat(64),
			undefined,
			source,
		).owner
		expect(parked.park!.types).toEqual([])
		expect(
			JSON.stringify({ ...parked, park: { ...parked.park, alerted: true } })
				.length,
		).toBeLessThanOrEqual(500)
	})
	it('terminal completion cannot close a later claim in the same generation', async () => {
		const h = fixture(),
			key = stragglerOwnerKey('synthetic-owner')
		const a = h.invocation(starter(), async () => {
			const owner = h.owners.get(key)!
			h.owners.set(key, {
				...owner,
				next: owner.next + 1,
				claimedBy: 'later-run',
			})
			return { status: 'delivered', accepted: 0, rejected: 1 }
		})
		await a.execute()
		expect(h.owners.get(key)).toMatchObject({
			state: 'active',
			next: 3,
			claimedBy: 'later-run',
		})
	})
	it('a completed same-run claim replay cannot birth a replacement generation', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		h.deliver.mockResolvedValueOnce({ accepted: 1, rejected: 0 })
		await a.execute()
		const original = structuredClone([...h.owners.values()][0])
		a.cache.clear()
		expect(await a.execute()).toEqual({ status: 'joined' })
		expect([...h.owners.values()][0]).toEqual(original)
		expect(h.deliver).toHaveBeenCalledOnce()
	})
	it('queued marked histories retain the owner reader when the producer switch is unset', async () => {
		const h = fixture(),
			a = h.invocation(starter())
		expect((await a.execute()).status).toBe('rescheduled')
		expect(a.sent[0]!.data.stragglerOwner?.generation).toBe(
			[...h.owners.values()][0]!.generation,
		)
	})
	it.each([
		'event2',
		'x'.repeat(65),
		'',
		'event-not-live,,cold-start-unhandled',
	])('normalizes an unreadable park code before persisting: %s', (code) => {
		const first = claimStragglerOwner(
			undefined,
			{ protocol: 1, startedAt: start },
			1,
			start,
			'synthetic-run',
		)
		const parked = claimStragglerOwner(
			first.owner,
			{ protocol: 1, startedAt: start, generation: first.owner.generation },
			2,
			start + STRAGGLER_PARK_AFTER_MS,
			'next-run',
			undefined,
			{ code, types: [] },
		).owner
		expect(parked.park!.code).toBe('unknown')
		expect(isStragglerParkCode(parked.park!.code)).toBe(true)
	})
	it('rejects malformed owner inputs before sending or claiming', () => {
		expect(() =>
			claimStragglerOwner(
				undefined,
				{ protocol: 1, startedAt: Number.NaN },
				1,
				start,
				'synthetic-claim',
			),
		).toThrow('clock')
		expect(() =>
			claimStragglerOwner(
				undefined,
				{ protocol: 1, startedAt: start, generation: 'lost' },
				2,
				start,
				'synthetic-claim',
			),
		).toThrow('original owner')
	})
})
