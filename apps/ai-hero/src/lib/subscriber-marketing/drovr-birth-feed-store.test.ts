import { describe, expect, it, vi } from 'vitest'
import {
	createRedisBirthFeedStore,
	LOAD_BIRTH_FEED,
	CONSUME_BIRTH_FEED,
	MEMBERS_BIRTH_FEED,
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
	it('null means bootstrap, never a fabricated checkpoint', async () => {
		expect(await harness(null).store.load('journey')).toBeNull()
	})
	it.each([
		'cache-lost',
		{},
		{ ...checkpoint, phase: 'other' },
		{ ...checkpoint, asOf: 'bad' },
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
