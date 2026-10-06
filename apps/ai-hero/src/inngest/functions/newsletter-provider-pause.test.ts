import { describe, expect, it } from 'vitest'
import { NonRetriableError } from 'inngest'
import {
	createNewsletterProviderPause, newsletterPauseDurationMs,
	EXTEND_NEWSLETTER_PAUSE, READ_NEWSLETTER_PAUSE, NEWSLETTER_PAUSE_KEY,
	type NewsletterPauseStore,
} from './newsletter-provider-pause'

/** Logical-clock software model of Redis PTTL and the exact Lua contract.
 * No Redis instance or network. This is NOT independent server atomicity proof. */
class FakePauseStore implements NewsletterPauseStore {
	now = Date.parse('2026-10-04T00:00:00Z')
	expiresAt = 0
	fail: 'read' | 'write' | undefined
	badTtl: unknown = undefined
	calls: { script: string; keys: string[]; args: (string | number)[] }[] = []
	async eval(script: string, keys: string[], args: (string | number)[]) {
		this.calls.push({ script, keys, args })
		const op = script === READ_NEWSLETTER_PAUSE ? 'read' : 'write'
		if (this.fail === op) throw new Error('private transport detail must never escape')
		if (this.badTtl !== undefined) return this.badTtl
		const remaining = this.expiresAt > this.now ? this.expiresAt - this.now : -2
		if (op === 'read') return remaining
		expect(script).toBe(EXTEND_NEWSLETTER_PAUSE)
		const requested = args[0]
		if (typeof requested !== 'number') throw new Error('invalid fake input')
		this.expiresAt = this.now + Math.max(remaining, requested)
		return this.expiresAt - this.now
	}
}

describe('newsletter durable pause contract, synthetic store', () => {
	it('active pauses next run/reexecution; exact TTL expiry permits work', async () => {
		const store = new FakePauseStore()
		const first = createNewsletterProviderPause({ store, now: () => store.now })
		expect(await first.isPaused()).toBe(false)
		await first.pause(undefined)
		const fresh = createNewsletterProviderPause({ store, now: () => store.now })
		expect(await fresh.isPaused()).toBe(true)
		store.now += 119999
		expect(await fresh.isPaused()).toBe(true)
		store.now += 1
		expect(await fresh.isPaused()).toBe(false)
		expect(store.calls.every(call => call.keys.length === 1 && call.keys[0] === NEWSLETTER_PAUSE_KEY)).toBe(true)
	})
	it('concurrent shorter updates cannot shorten an existing longer TTL', async () => {
		const store = new FakePauseStore()
		const pause = createNewsletterProviderPause({ store, now: () => store.now })
		await pause.pause('300')
		store.now += 1000
		await Promise.all([pause.pause('1'), pause.pause('120')])
		expect(store.expiresAt - store.now).toBe(299000)
		await pause.pause('600')
		expect(store.expiresAt - store.now).toBe(600000)
		expect(EXTEND_NEWSLETTER_PAUSE).toContain("'SET', KEYS[1], 'kit-429', 'PX', requested")
		expect(EXTEND_NEWSLETTER_PAUSE).toContain('if remaining >= requested then return remaining end')
	})
	it('honors positive integer seconds and a future HTTP date relative to clock', () => {
		const now = Date.parse('2026-10-04T00:00:00Z')
		expect(newsletterPauseDurationMs(' 180 ', now)).toBe(180000)
		expect(newsletterPauseDurationMs(new Date(now + 180000).toUTCString(), now)).toBe(180000)
		expect(newsletterPauseDurationMs('86400', now)).toBe(86400000)
	})
	it.each([undefined, '', 'garbage', '-1', '0', '0.5', '86401', '9007199254740992', 'Sun, 04 Oct 2026 00:00:00 GMT', 'Sat, 03 Oct 2026 00:00:00 GMT'])(
		'missing/invalid/zero/past/excessive Retry-After %j falls back, never immediate retry', value => {
			expect(newsletterPauseDurationMs(value, Date.parse('2026-10-04T00:00:00Z'))).toBe(120000)
		},
	)
	it.each(['read', 'write'] as const)('first %s failure is visible, non-retriable and not repeated', async operation => {
		const store = new FakePauseStore(); store.fail = operation
		const pause = createNewsletterProviderPause({ store, now: () => store.now })
		const work = operation === 'read' ? pause.isPaused() : pause.pause('180')
		await expect(work).rejects.toBeInstanceOf(NonRetriableError)
		expect(store.calls).toHaveLength(1)
	})
	it.each([-1, -3, '120000', null, NaN, 1.5])('unexpected TTL %j fails closed, without repair or transport details', async value => {
		const store = new FakePauseStore(); store.badTtl = value
		const pause = createNewsletterProviderPause({ store, now: () => store.now })
		await expect(pause.isPaused()).rejects.toThrow('invalid-ttl')
		expect(store.calls).toHaveLength(1)
	})
	it('discloses TTL-expired replay gap rather than inventing indefinite run protection', async () => {
		const store = new FakePauseStore()
		await createNewsletterProviderPause({ store, now: () => store.now }).pause('1')
		store.now += 1000
		// Without Inngest's saved step result, the TTL marker alone no longer stops
		// an old run. This assertion records the boundary, not a protection PASS.
		expect(await createNewsletterProviderPause({ store, now: () => store.now }).isPaused()).toBe(false)
	})
})
