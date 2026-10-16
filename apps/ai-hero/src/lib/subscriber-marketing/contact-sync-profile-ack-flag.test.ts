import { afterEach, expect, it, vi } from 'vitest'
import { DROVR_PROFILE_ACK_ENABLED, FLAGS } from '@/flags/flag-definitions'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { profileAckEnabled } from './contact-sync-profile-ack-flag-live'
const read = vi.hoisted(() => vi.fn())
vi.mock('server-only', () => ({}))
vi.mock('@/server/redis-client', () => ({ redis: { get: read } }))
vi.mock('@/flags/flags-adapter', () => ({
	getFlagKey: (key: string) => `flag:test:${key}`,
}))
afterEach(() => {
	vi.useRealTimers()
	read.mockReset()
})
it('registers the normal app/admin flag, default OFF in ALL environments', () => {
	expect(DROVR_PROFILE_ACK_ENABLED).toBe('drovr-profile-ack-enabled')
	expect(FLAGS[DROVR_PROFILE_ACK_ENABLED].defaultValue).toEqual({
		production: false,
		preview: false,
		development: false,
		test: false,
	})
})
it.each([true, 'true', '1', 1])(
	'uses the same affirmative stored values as C5: %j',
	async (value) => {
		expect(await profileAckFlagEnabled({ readFlag: async () => value })).toBe(
			true,
		)
	},
)
it.each([null, undefined, false, 'false', '0', 0, '', {}, [], 'yes'])(
	'fails closed for missing or non-affirmative stored flag %j',
	async (value) => {
		expect(await profileAckFlagEnabled({ readFlag: async () => value })).toBe(
			false,
		)
	},
)
it('fails closed when a flag read rejects or throws; no env fallback enables it', async () => {
	expect(
		await profileAckFlagEnabled({
			readFlag: async () => {
				throw new Error('synthetic Redis failure')
			},
		}),
	).toBe(false)
	expect(
		await profileAckFlagEnabled({
			readFlag: () => {
				throw new Error('synthetic immediate flag read failure')
			},
		}),
	).toBe(false)
})
it('fails closed on a hung read and ignores a late affirmative answer', async () => {
	vi.useFakeTimers()
	let finish!: (value: unknown) => void
	const value = profileAckFlagEnabled({
		readFlag: () =>
			new Promise((resolve) => {
				finish = resolve
			}),
		timeoutMs: 50,
	})
	await vi.advanceTimersByTimeAsync(50)
	expect(await value).toBe(false)
	finish(true)
	expect(await value).toBe(false)
	expect(vi.getTimerCount()).toBe(0)
})
it('reads the actual app flag namespace freshly each time without writing dashboard state', async () => {
	read
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(false)
		.mockRejectedValueOnce(new Error('synthetic Redis outage'))
	expect(await profileAckEnabled()).toBe(true)
	expect(await profileAckEnabled()).toBe(false)
	expect(await profileAckEnabled()).toBe(false)
	expect(read.mock.calls).toEqual(
		Array.from({ length: 3 }, () => ['flag:test:drovr-profile-ack-enabled']),
	)
})
