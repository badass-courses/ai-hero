import { describe, expect, it, vi } from 'vitest'

import {
	createSessionAccessCache,
	DEFAULT_SESSION_ACCESS_CACHE_TTL_SECONDS,
	isSessionAccessCacheable,
	MAX_SESSION_ACCESS_CACHE_TTL_SECONDS,
	parseSessionAccessCacheTtl,
	sessionAccessEntryKey,
	sessionAccessGenerationKey,
	type SessionAccessCacheStore,
} from './session-access-cache'
import { createFakeStore, sessionAccessFixture } from './__fixtures__/session-access'

const TOKEN = 'b2f3c9d0-6a1e-4f7b-9c2d-3e4f5a6b7c8d'
const USER_ID = 'user-1'
const START = 1_800_000_000_000

function cacheWith(
	store: SessionAccessCacheStore | null,
	options: {
		ttlSeconds?: number
		timeoutMs?: number
		now?: () => number
	} = {},
) {
	const onEvent = vi.fn()
	const cache = createSessionAccessCache({
		getStore: async () => store,
		ttlSeconds: options.ttlSeconds ?? 60,
		timeoutMs: options.timeoutMs,
		onEvent,
		now: options.now ?? (() => START),
	})
	return { cache, onEvent }
}

const fill = (generation: number, loadStartedAt = START) => ({
	generation,
	loadStartedAt,
})

/** A manual clock shared by the cache and the fake store. */
function fakeClock() {
	let now = START
	return {
		now: () => now,
		at: (ms: number) => {
			now = START + ms
		},
	}
}

/** A store whose SETs can be held in flight and landed later. */
function storeWithHeldSets(now: () => number) {
	const store = createFakeStore(now)
	const realSet = store.set
	const held: Array<() => Promise<unknown>> = []
	store.set = vi.fn(
		(key: string, value: unknown, options: { px: number }) =>
			new Promise<unknown>((resolve) => {
				held.push(() => realSet(key, value, options).then(resolve))
			}),
	)
	return { store, landHeldSets: () => Promise.all(held.map((land) => land())) }
}

describe('parseSessionAccessCacheTtl', () => {
	it('defaults, disables at 0, caps, and rejects junk', () => {
		expect(parseSessionAccessCacheTtl(undefined)).toBe(
			DEFAULT_SESSION_ACCESS_CACHE_TTL_SECONDS,
		)
		expect(parseSessionAccessCacheTtl('')).toBe(60)
		expect(parseSessionAccessCacheTtl('0')).toBe(0)
		expect(parseSessionAccessCacheTtl('15')).toBe(15)
		expect(MAX_SESSION_ACCESS_CACHE_TTL_SECONDS).toBe(300)
		expect(parseSessionAccessCacheTtl('300')).toBe(300)
		expect(parseSessionAccessCacheTtl('301')).toBe(300)
		expect(parseSessionAccessCacheTtl('999999')).toBe(300)
		expect(parseSessionAccessCacheTtl('-5')).toBe(60)
		expect(parseSessionAccessCacheTtl('1.5')).toBe(60)
		expect(parseSessionAccessCacheTtl('sixty')).toBe(60)
	})
})

describe('session access cache keys', () => {
	it('never contains the raw session token', async () => {
		const key = await sessionAccessEntryKey(TOKEN)
		expect(key).not.toContain(TOKEN)
		expect(key).toMatch(/^aih:session-access:v1:[0-9a-f]{64}$/)
		expect(await sessionAccessEntryKey(TOKEN)).toBe(key)
		expect(await sessionAccessEntryKey(`${TOKEN}x`)).not.toBe(key)
	})

	it('writes no raw token into any key or value', async () => {
		const store = createFakeStore()
		const { cache } = cacheWith(store)
		await cache.read(TOKEN, USER_ID)
		await cache.write(TOKEN, USER_ID, fill(0), sessionAccessFixture())
		await cache.bustUser(USER_ID)
		await cache.bustSessionToken(TOKEN)
		await cache.write(TOKEN, USER_ID, fill(1), sessionAccessFixture())

		const touched = [
			...vi.mocked(store.mget).mock.calls.flat(),
			...vi.mocked(store.set).mock.calls.map(([key, value]) =>
				[key, JSON.stringify(value)].join(' '),
			),
			...vi.mocked(store.del).mock.calls.flat(),
			...vi.mocked(store.incr).mock.calls.flat(),
			...vi.mocked(store.expire).mock.calls.map(([key]) => key),
			...store.data.keys(),
		]
		expect(touched.length).toBeGreaterThan(0)
		for (const text of touched) expect(String(text)).not.toContain(TOKEN)
	})
})

describe('session access cache', () => {
	it('misses, then hits with the same shape and revived dates', async () => {
		const store = createFakeStore()
		const { cache } = cacheWith(store)
		const access = sessionAccessFixture()

		expect(await cache.read(TOKEN, USER_ID)).toEqual({
			status: 'miss',
			generation: 0,
			loadStartedAt: START,
		})
		await cache.write(TOKEN, USER_ID, fill(0), access)

		const hit = await cache.read(TOKEN, USER_ID)
		expect(hit).toEqual({ status: 'hit', access })
		if (hit.status !== 'hit') throw new Error('expected hit')
		expect(hit.access.roles[0]?.createdAt).toBeInstanceOf(Date)
		expect(hit.access.memberships[0]?.createdAt).toBeInstanceOf(Date)
		expect(vi.mocked(store.set).mock.calls[0]?.[2]).toEqual({ px: 60_000 })
	})

	it('expires entries after the TTL', async () => {
		const clock = fakeClock()
		const store = createFakeStore(clock.now)
		const { cache } = cacheWith(store, { ttlSeconds: 60, now: clock.now })
		await cache.write(TOKEN, USER_ID, fill(0), sessionAccessFixture())

		clock.at(59_000)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('hit')
		clock.at(60_000)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
	})

	it('expires one TTL after the load started, not after the write', async () => {
		const clock = fakeClock()
		const store = createFakeStore(clock.now)
		const { cache } = cacheWith(store, { ttlSeconds: 60, now: clock.now })
		const miss = await cache.read(TOKEN, USER_ID)
		if (miss.status !== 'miss') throw new Error('expected miss')

		clock.at(45_000)
		await cache.write(TOKEN, USER_ID, miss, sessionAccessFixture())
		expect(vi.mocked(store.set).mock.calls[0]?.[2]).toEqual({ px: 15_000 })
		clock.at(59_999)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('hit')
		clock.at(60_000)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
	})

	it('skips the write when the load overran the TTL', async () => {
		const clock = fakeClock()
		const store = createFakeStore(clock.now)
		const { cache } = cacheWith(store, { ttlSeconds: 60, now: clock.now })
		const miss = await cache.read(TOKEN, USER_ID)
		if (miss.status !== 'miss') throw new Error('expected miss')

		clock.at(60_000)
		await cache.write(TOKEN, USER_ID, miss, sessionAccessFixture())
		clock.at(90_000)
		await cache.write(TOKEN, USER_ID, miss, sessionAccessFixture())
		expect(store.set).not.toHaveBeenCalled()
	})

	it('never serves a slow pre-revoke fill past one TTL after the revoke', async () => {
		const clock = fakeClock()
		const { store, landHeldSets } = storeWithHeldSets(clock.now)
		const { cache } = cacheWith(store, {
			ttlSeconds: 60,
			timeoutMs: 5,
			now: clock.now,
		})
		const granted = sessionAccessFixture()

		// 1. A miss at generation 0 starts a load that reads the old grant.
		const miss = await cache.read(TOKEN, USER_ID)
		if (miss.status !== 'miss') throw new Error('expected miss')
		// 2. The revoke commits a second later and its bust fails.
		const revokedAt = START + 1_000
		clock.at(1_000)
		store.incr = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
		await cache.bustUser(USER_ID)
		// 3. The load returns late; its SET times out and lands much later.
		clock.at(30_000)
		await cache.write(TOKEN, USER_ID, miss, granted)
		clock.at(100_000)
		await landHeldSets()
		expect(store.data.size).toBeGreaterThan(0)

		// 4. Redis still holds the entry, but no read serves it past the bound.
		for (let at = 100_000; at <= 200_000; at += 1_000) {
			clock.at(at)
			expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
		}
		expect(START + 100_000).toBeGreaterThan(revokedAt + 60_000)
	})

	it('rejects a late write that lands after the timeout once the deadline passes', async () => {
		const clock = fakeClock()
		const { store, landHeldSets } = storeWithHeldSets(clock.now)
		const { cache, onEvent } = cacheWith(store, {
			ttlSeconds: 60,
			timeoutMs: 5,
			now: clock.now,
		})
		const miss = await cache.read(TOKEN, USER_ID)
		if (miss.status !== 'miss') throw new Error('expected miss')

		clock.at(10_000)
		await cache.write(TOKEN, USER_ID, miss, sessionAccessFixture())
		expect(onEvent).toHaveBeenCalledWith('write-failed', expect.any(Error))
		// The SET lands 40s after it was sent, with its 50s PX from send time.
		clock.at(50_000)
		await landHeldSets()
		clock.at(59_000)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('hit')
		clock.at(60_000)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
		expect(store.data.size).toBeGreaterThan(0)
	})

	it('treats an entry stamped in the future as expired', async () => {
		const clock = fakeClock()
		const store = createFakeStore(clock.now)
		const { cache } = cacheWith(store, { ttlSeconds: 60, now: clock.now })
		await cache.write(TOKEN, USER_ID, fill(0, START), sessionAccessFixture())
		store.data.set(await sessionAccessEntryKey(TOKEN), {
			value: JSON.stringify({
				...JSON.parse(store.data.get(await sessionAccessEntryKey(TOKEN))!.value),
				loadStartedAt: START + 5_000,
			}),
			expiresAt: null,
		})
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
	})

	it('misses after a user bust, including entries written mid-load', async () => {
		const store = createFakeStore()
		const { cache } = cacheWith(store)
		const access = sessionAccessFixture()

		const first = await cache.read(TOKEN, USER_ID)
		if (first.status !== 'miss') throw new Error('expected miss')
		// A role write lands while this request is still loading from the DB.
		await cache.bustUser(USER_ID)
		await cache.write(TOKEN, USER_ID, first, access)
		expect(await cache.read(TOKEN, USER_ID)).toEqual({
			status: 'miss',
			generation: 1,
			loadStartedAt: START,
		})

		await cache.write(TOKEN, USER_ID, fill(1), access)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('hit')
		await cache.bustUser(USER_ID)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
		expect(store.data.get(sessionAccessGenerationKey(USER_ID))?.expiresAt).not.toBe(
			null,
		)
	})

	it('drops the entry on sign-out', async () => {
		const store = createFakeStore()
		const { cache } = cacheWith(store)
		await cache.write(TOKEN, USER_ID, fill(0), sessionAccessFixture())
		await cache.bustSessionToken(TOKEN)
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
	})

	it('misses when the entry belongs to another user or is malformed', async () => {
		const store = createFakeStore()
		const { cache, onEvent } = cacheWith(store)
		await cache.write(TOKEN, 'someone-else', fill(0), sessionAccessFixture())
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')

		store.data.set(await sessionAccessEntryKey(TOKEN), {
			value: JSON.stringify({ v: 1, userId: USER_ID, generation: 0 }),
			expiresAt: null,
		})
		expect((await cache.read(TOKEN, USER_ID)).status).toBe('miss')
		expect(onEvent).toHaveBeenCalledWith('entry-invalid')
	})

	it('bypasses when the TTL is 0 but still busts', async () => {
		const store = createFakeStore()
		const { cache } = cacheWith(store, { ttlSeconds: 0 })
		expect(await cache.read(TOKEN, USER_ID)).toEqual({ status: 'bypass' })
		await cache.write(TOKEN, USER_ID, fill(0), sessionAccessFixture())
		expect(store.set).not.toHaveBeenCalled()
		expect(store.mget).not.toHaveBeenCalled()
		await cache.bustUser(USER_ID)
		expect(store.incr).toHaveBeenCalledOnce()
	})

	it('bypasses without a configured store', async () => {
		const { cache } = cacheWith(null)
		expect(await cache.read(TOKEN, USER_ID)).toEqual({ status: 'bypass' })
		await expect(
			cache.write(TOKEN, USER_ID, fill(0), sessionAccessFixture()),
		).resolves.toBeUndefined()
		await expect(cache.bustUser(USER_ID)).resolves.toBeUndefined()
	})

	it('falls through when Redis is down', async () => {
		const down = new Error('connect ECONNREFUSED')
		const store: SessionAccessCacheStore = {
			mget: vi.fn().mockRejectedValue(down),
			set: vi.fn().mockRejectedValue(down),
			del: vi.fn().mockRejectedValue(down),
			incr: vi.fn().mockRejectedValue(down),
			expire: vi.fn().mockRejectedValue(down),
		}
		const { cache, onEvent } = cacheWith(store)
		expect(await cache.read(TOKEN, USER_ID)).toEqual({ status: 'bypass' })
		await expect(
			cache.write(TOKEN, USER_ID, fill(0), sessionAccessFixture()),
		).resolves.toBeUndefined()
		await expect(cache.bustUser(USER_ID)).resolves.toBeUndefined()
		await expect(cache.bustSessionToken(TOKEN)).resolves.toBeUndefined()
		expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
			'read-failed',
			'write-failed',
			'bust-failed',
			'bust-failed',
		])
	})

	it('falls through when Redis hangs past the timeout', async () => {
		const store = createFakeStore()
		store.mget = vi.fn(() => new Promise<unknown[]>(() => {}))
		const { cache, onEvent } = cacheWith(store, { timeoutMs: 10 })
		expect(await cache.read(TOKEN, USER_ID)).toEqual({ status: 'bypass' })
		expect(onEvent).toHaveBeenCalledWith('read-failed', expect.any(Error))
	})

	it('falls through when the store itself cannot be created', async () => {
		const onEvent = vi.fn()
		const cache = createSessionAccessCache({
			getStore: async () => {
				throw new Error('bad url')
			},
			ttlSeconds: 60,
			onEvent,
		})
		expect(await cache.read(TOKEN, USER_ID)).toEqual({ status: 'bypass' })
	})
})

describe('isSessionAccessCacheable', () => {
	it('reads users with no roles or memberships live', () => {
		const access = sessionAccessFixture()
		expect(isSessionAccessCacheable(access)).toBe(true)
		expect(isSessionAccessCacheable({ ...access, roles: [] })).toBe(false)
		expect(isSessionAccessCacheable({ ...access, memberships: [] })).toBe(false)
	})
})
