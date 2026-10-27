import { describe, expect, it, vi } from 'vitest'
import {
	createRedisBirthFeedStore,
	LOAD_BIRTH_FEED,
	CONSUME_BIRTH_FEED,
	MEMBERS_BIRTH_FEED,
	RESERVE_BIRTH_FEED_CALL,
	OBSERVE_BIRTH_FEED,
	BIRTH_FEED_QUOTA_TTL_SECONDS,
	BIRTH_CONFIRMATION_COOLDOWN_SECONDS,
	DEFER_BIRTH_CONFIRMATION,
	DEFERRED_BIRTH_CONFIRMATIONS,
} from './drovr-birth-feed-store'
import type { BirthFeedCheckpoint } from './drovr-birth-feed'
vi.mock('@/env.mjs', () => ({ env: {} }))
const checkpoint: BirthFeedCheckpoint = {
	schemaVersion: 1,
	since: '2026-10-04T00:00:00Z',
	resumeCursor: 'opaque/+cursor',
	asOf: '2026-10-07T16:00:00Z',
	phase: 'caught-up',
}
function harness(value: unknown) {
	const evalScript = vi.fn(
		async (
			_script: string,
			_keys: string[],
			_args: string[],
		): Promise<unknown> => value,
	)
	return {
		evalScript,
		store: createRedisBirthFeedStore({
			redis: { eval: evalScript },
			tenantId: 'org-aihero',
		}),
	}
}
describe('birth feed durable boundary', () => {
	it('cooldowns are owner-event/journey scoped, expire, and never renew on retry or lookup', async () => {
		const h = harness(1)
		await h.store.deferConfirmation('journey', 'owner/+id')
		expect(h.evalScript).toHaveBeenCalledWith(
			DEFER_BIRTH_CONFIRMATION,
			[
				expect.stringContaining(
					'org-aihero:journey}:v1:confirm-cooldown:owner%2F%2Bid',
				),
			],
			[String(BIRTH_CONFIRMATION_COOLDOWN_SECONDS)],
		)
		expect(BIRTH_CONFIRMATION_COOLDOWN_SECONDS).toBe(6 * 3600)
		expect(DEFER_BIRTH_CONFIRMATION).toContain("'NX'")
		const lookup = harness([1, 0])
		expect(
			await lookup.store.deferredConfirmations('journey', ['a', 'b']),
		).toEqual(new Set(['a']))
		expect(lookup.evalScript.mock.calls[0]?.[0]).toBe(
			DEFERRED_BIRTH_CONFIRMATIONS,
		)
		expect(DEFERRED_BIRTH_CONFIRMATIONS).not.toMatch(/EXPIRE|SET|TTL/)
		expect(await lookup.store.deferredConfirmations('journey', [])).toEqual(
			new Set(),
		)
	})
	it.each([{ value: null }, { value: [1] }, { value: ['1', 0] }])(
		'invalid cooldown lookup $value fails closed',
		async ({ value }) => {
			await expect(
				harness(value).store.deferredConfirmations('journey', ['a', 'b']),
			).rejects.toThrow('confirmation-cooldown-unavailable')
		},
	)
	it('failed cooldown write cannot silently continue into reposting', async () => {
		await expect(
			harness(0).store.deferConfirmation('journey', 'a'),
		).rejects.toThrow('confirmation-cooldown-unavailable')
	})
	it('confirmation reads share a separate 25-call budget across journeys, not another births allowance', async () => {
		const h = harness(1)
		await h.store.reserveConfirmation('run')
		expect(h.evalScript).toHaveBeenCalledWith(
			RESERVE_BIRTH_FEED_CALL,
			[expect.stringContaining('confirm-budget')],
			['25', String(BIRTH_FEED_QUOTA_TTL_SECONDS)],
		)
	})
	it('confirmed old actors become positive membership without advancing the cursor', async () => {
		const h = harness(1)
		await h.store.observeBorn('journey', 'old-actor')
		expect(h.evalScript).toHaveBeenCalledWith(
			OBSERVE_BIRTH_FEED,
			[expect.stringContaining(':members')],
			['__aih_birth_feed_ready_v1__', 'old-actor'],
		)
		expect(OBSERVE_BIRTH_FEED).not.toContain('checkpoint')
		await expect(
			harness(0).store.observeBorn('journey', 'old-actor'),
		).rejects.toThrow('membership-unavailable')
	})

	it('reserves one tenant/run quota with retention exceeding the bounded run', async () => {
		const h = harness(1)
		await h.store.reserveCall('run/+id')
		expect(h.evalScript).toHaveBeenCalledWith(
			RESERVE_BIRTH_FEED_CALL,
			[expect.stringContaining('run%2F%2Bid:budget')],
			['10', String(BIRTH_FEED_QUOTA_TTL_SECONDS)],
		)
		expect(BIRTH_FEED_QUOTA_TTL_SECONDS).toBeGreaterThanOrEqual(24 * 3600)
		expect(RESERVE_BIRTH_FEED_CALL).toContain(
			"calls == 1 then redis.call('EXPIRE'",
		)
	})
	it.each([0, null, '1'])(
		'closed quota result %s forbids another GET',
		async (value) => {
			await expect(harness(value).store.reserveCall('run')).rejects.toThrow(
				'page-cap-exceeded',
			)
		},
	)

	it.each([checkpoint, JSON.stringify(checkpoint)])(
		'parses SDK-deserialized or serialized metadata without interpreting the cursor',
		async (value) => {
			const h = harness(value)
			expect(await h.store.load('journey')).toEqual(checkpoint)
			expect(h.evalScript).toHaveBeenCalledWith(
				LOAD_BIRTH_FEED,
				expect.arrayContaining([expect.stringContaining('org-aihero:journey')]),
				expect.any(Array),
			)
		},
	)
	it('loads a retry-only bootstrap without inventing a cursor or watermark', async () => {
		const bootstrap = {
			...checkpoint,
			phase: 'bootstrap',
			resumeCursor: null,
			asOf: null,
			retry: { notBefore: '2026-10-08T00:00:00Z', status: 503 },
		}
		expect(
			await harness(JSON.stringify(bootstrap)).store.load('journey'),
		).toEqual(bootstrap)
	})
	it('executes consume against a stateful CAS fake: stale holds cannot clear or rewind, replay is idempotent', async () => {
		// Stateful Redis boundary fake, not a Lua interpreter. The separate
		// source-Lua proof also executes these cases against an owned engine.
		let raw: string | undefined
		const members = new Set<string>()
		const identity = (value: BirthFeedCheckpoint | null) =>
			value === null
				? null
				: [
						value.schemaVersion,
						value.since,
						value.resumeCursor,
						value.asOf,
						value.phase,
						value.retry?.notBefore,
						value.retry?.status,
					]
		const evalScript = vi.fn(
			async (
				script: string,
				_keys: string[],
				args: string[],
			): Promise<unknown> => {
				if (script === LOAD_BIRTH_FEED)
					return (!raw && members.size) || (raw && !members.has(args[0]!))
						? 'cache-lost'
						: (raw ?? null)
				if (script !== CONSUME_BIRTH_FEED)
					throw new Error('unsupported fixture script')
				const current: BirthFeedCheckpoint | null = raw ? JSON.parse(raw) : null
				const previous: BirthFeedCheckpoint | null = JSON.parse(args[0]!)
				const desired: BirthFeedCheckpoint = JSON.parse(args[1]!)
				if (raw && !members.has(args[2]!)) return -1
				const actual = JSON.stringify(identity(current))
				if (
					actual !== JSON.stringify(identity(previous)) &&
					actual !== JSON.stringify(identity(desired))
				)
					return 0
				for (const id of args.slice(2)) members.add(id)
				raw = args[1]!
				return 1
			},
		)
		const store = createRedisBirthFeedStore({
			redis: { eval: evalScript },
			tenantId: 'fixture',
		})
		const hold: BirthFeedCheckpoint = {
			...checkpoint,
			retry: { status: 503, notBefore: '2026-10-08T12:00:00Z' },
		}
		const consumed: BirthFeedCheckpoint = {
			...checkpoint,
			resumeCursor: 'opaque-after',
		}
		await store.consume({
			journeyId: 'j',
			previous: null,
			checkpoint: hold,
			contactIds: ['retained'],
		})
		await expect(
			store.consume({
				journeyId: 'j',
				previous: null,
				checkpoint: consumed,
				contactIds: ['wrong-null'],
			}),
		).rejects.toThrow('checkpoint-conflict-or-cache-loss')
		await expect(
			store.consume({
				journeyId: 'j',
				previous: {
					...hold,
					retry: { status: 503, notBefore: '2026-10-08T11:00:00Z' },
				},
				checkpoint: consumed,
				contactIds: ['wrong-deadline'],
			}),
		).rejects.toThrow('checkpoint-conflict-or-cache-loss')
		expect(await store.load('j')).toEqual(hold)
		await store.consume({
			journeyId: 'j',
			previous: hold,
			checkpoint: consumed,
			contactIds: ['new'],
		})
		await store.consume({
			journeyId: 'j',
			previous: hold,
			checkpoint: consumed,
			contactIds: ['new'],
		})
		await expect(
			store.consume({
				journeyId: 'j',
				previous: null,
				checkpoint: hold,
				contactIds: ['rewind'],
			}),
		).rejects.toThrow('checkpoint-conflict-or-cache-loss')
		expect(await store.load('j')).toEqual(consumed)
		expect(members.has('retained')).toBe(true)
		expect(members.has('new')).toBe(true)
		expect(
			['wrong-null', 'wrong-deadline', 'rewind'].some((id) => members.has(id)),
		).toBe(false)
		expect(evalScript).toHaveBeenCalledWith(
			CONSUME_BIRTH_FEED,
			expect.any(Array),
			expect.any(Array),
		)
	})
	it('null means bootstrap, never a fabricated checkpoint', async () => {
		expect(await harness(null).store.load('journey')).toBeNull()
	})
	it.each([
		'cache-lost',
		{},
		{ ...checkpoint, phase: 'other' },
		{ ...checkpoint, asOf: 'bad' },
		{ ...checkpoint, resumeCursor: null },
		{ ...checkpoint, phase: 'bootstrap' },
		{ ...checkpoint, phase: 'bootstrap', resumeCursor: null },
		{ ...checkpoint, retry: { notBefore: 'bad', status: 503 } },
		{
			...checkpoint,
			retry: { notBefore: '2026-10-08T00:00:00Z', status: 200 },
		},
	])('invalid/lost cache fails closed', async (value) => {
		await expect(harness(value).store.load('journey')).rejects.toThrow(
			'invalid-checkpoint',
		)
	})
	it('consumes every membership and the position in one atomic compare-and-set with no expiry', async () => {
		const h = harness(1)
		await h.store.consume({
			journeyId: 'journey',
			previous: null,
			checkpoint,
			contactIds: ['a', 'b'],
		})
		const [script, keys, args] = h.evalScript.mock.calls[0]!
		expect(script).toBe(CONSUME_BIRTH_FEED)
		expect(keys).toHaveLength(2)
		expect(keys[0]?.match(/\{[^}]+\}/)?.[0]).toBe(
			keys[1]?.match(/\{[^}]+\}/)?.[0],
		)
		expect(JSON.parse(args[0]!)).toBeNull()
		expect(JSON.parse(args[1]!)).toEqual(checkpoint)
		expect(args.slice(3)).toEqual(['a', 'b'])
		expect(script).toContain('equal(current, expected)')
		expect(script).not.toContain('EXPIRE')
	})
	it.each([0, -1, null, '1'])(
		'conflict/cache loss result %s cannot count as a saved page',
		async (value) => {
			await expect(
				harness(value).store.consume({
					journeyId: 'journey',
					previous: null,
					checkpoint,
					contactIds: ['a'],
				}),
			).rejects.toThrow('checkpoint-conflict-or-cache-loss')
		},
	)
	it('reads only requested memberships with journey/tenant-bound keys', async () => {
		const h = harness([1, 0])
		expect(
			await h.store.members({ journeyId: 'journey', contactIds: ['a', 'b'] }),
		).toEqual(new Set(['a']))
		expect(h.evalScript.mock.calls[0]?.[0]).toBe(MEMBERS_BIRTH_FEED)
		const other = createRedisBirthFeedStore({
			redis: { eval: h.evalScript },
			tenantId: 'other-tenant',
		})
		await other.members({ journeyId: 'other-journey', contactIds: ['a', 'b'] })
		expect(h.evalScript.mock.calls[1]?.[1][0]).not.toBe(
			h.evalScript.mock.calls[0]?.[1][0],
		)
	})
	it.each([false, null, [], [1, 2], ['1', '0']])(
		'missing/untyped membership result is never absence',
		async (value) => {
			await expect(
				harness(value).store.members({
					journeyId: 'journey',
					contactIds: ['a', 'b'],
				}),
			).rejects.toThrow('membership-unavailable')
		},
	)
	it('storage causes are scrubbed, not echoed as provider URLs or credentials', async () => {
		const h = harness(null)
		h.evalScript.mockRejectedValue(new Error('secret/private url'))
		await expect(h.store.load('journey')).rejects.toThrow('cache-unavailable')
	})
})
