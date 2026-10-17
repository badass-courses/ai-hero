import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FLAGS,
	SUBSCRIBE_BOT_ENFORCE,
	SUBSCRIBE_BOT_SHADOW,
} from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flag-key'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/server/redis-client', () => ({ redis: { get: mocks.get } }))

import {
	readSubscribeBotMode,
	readSubscribeBotModeStrict,
} from './subscribe-bot-mode.server'

describe('subscribe admin switches', () => {
	beforeEach(() => {
		mocks.get.mockReset().mockResolvedValue(null)
	})

	it('defaults off in every environment', async () => {
		expect(Object.values(FLAGS[SUBSCRIBE_BOT_SHADOW].defaultValue)).toEqual([
			false,
			false,
			false,
			false,
		])
		expect(Object.values(FLAGS[SUBSCRIBE_BOT_ENFORCE].defaultValue)).toEqual([
			false,
			false,
			false,
			false,
		])
		expect(await readSubscribeBotMode()).toBe('off')
		expect(mocks.get).toHaveBeenCalledWith(getFlagKey(SUBSCRIBE_BOT_SHADOW))
		expect(mocks.get).toHaveBeenCalledWith(getFlagKey(SUBSCRIBE_BOT_ENFORCE))
	})

	it.each([true, 'true', '1'])(
		'uses the existing adapter enabled encoding %s',
		async (value) => {
			mocks.get.mockImplementation(async (key: string) =>
				key === getFlagKey(SUBSCRIBE_BOT_SHADOW) ? value : null,
			)
			expect(await readSubscribeBotMode()).toBe('shadow')
		},
	)

	it.each([false, 'false', '0', 1, 'enforce', {}, undefined])(
		'does not treat %s as true',
		async (value) => {
			mocks.get.mockResolvedValue(value)
			expect(await readSubscribeBotMode()).toBe('off')
		},
	)

	it('fails open to off when the flag store throws', async () => {
		mocks.get.mockRejectedValue(new Error('synthetic outage'))
		expect(await readSubscribeBotMode()).toBe('off')
	})

	it('strict reads distinguish an outage from a genuine off value', async () => {
		mocks.get.mockRejectedValue(new Error('synthetic outage'))
		await expect(readSubscribeBotModeStrict()).rejects.toThrow(
			'synthetic outage',
		)
		mocks.get.mockResolvedValue(null)
		expect(await readSubscribeBotModeStrict()).toBe('off')
	})

	it('bounds a stalled flag store and leaves no deadline timer behind', async () => {
		vi.useFakeTimers()
		try {
			mocks.get.mockImplementation(() => new Promise(() => {}))
			const result = readSubscribeBotMode()
			const strict = expect(readSubscribeBotModeStrict()).rejects.toThrow(
				'timed out',
			)
			await vi.advanceTimersByTimeAsync(500)
			await strict
			expect(await result).toBe('off')
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})
