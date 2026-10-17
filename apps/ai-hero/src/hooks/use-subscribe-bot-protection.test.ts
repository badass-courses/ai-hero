import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	initialize: vi.fn(),
	effects: [] as Array<() => void>,
}))
vi.mock('react', () => ({
	useCallback: (fn: unknown) => fn,
	useEffect: (fn: () => void) => {
		mocks.effects.push(fn)
	},
	useRef: (value: unknown) => ({ current: value }),
}))
vi.mock('@/components/subscribe-bot-client', () => ({
	initializeSubscribeBotProtection: mocks.initialize,
}))

import { useSubscribeBotProtection } from './use-subscribe-bot-protection'

describe('subscribe form protection lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.initialize.mockReset().mockResolvedValue(undefined)
		mocks.effects.length = 0
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('reuses the mount-time promise on a submit under thirty seconds old', async () => {
		const prepare = useSubscribeBotProtection()
		mocks.effects[0]!()
		vi.setSystemTime(new Date('2026-01-01T00:00:29Z'))
		await prepare()
		expect(mocks.initialize).toHaveBeenCalledTimes(1)
	})

	it('performs no extra discovery fetch when the mount observed disabled', async () => {
		const actual = await vi.importActual<
			typeof import('@/components/subscribe-bot-client')
		>('@/components/subscribe-bot-client')
		mocks.initialize.mockImplementation(actual.initializeSubscribeBotProtection)
		const fetch = vi.fn().mockResolvedValue(Response.json({ enabled: false }))
		vi.stubGlobal('fetch', fetch)
		const prepare = useSubscribeBotProtection()
		mocks.effects[0]!()
		await prepare()
		await prepare()
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it('shares a still-pending mount discovery with the first submit', async () => {
		let complete!: () => void
		mocks.initialize.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve
			}),
		)
		const prepare = useSubscribeBotProtection()
		mocks.effects[0]!()
		const submit = prepare()
		expect(mocks.initialize).toHaveBeenCalledTimes(1)
		complete()
		await submit
	})

	it('refreshes discovery after thirty seconds', async () => {
		const prepare = useSubscribeBotProtection()
		mocks.effects[0]!()
		await prepare()
		vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
		await prepare()
		expect(mocks.initialize).toHaveBeenCalledTimes(2)
	})

	it('does not discover BotID for a custom unprotected submit URL', async () => {
		const prepare = useSubscribeBotProtection('/api/synthetic-other-form')
		mocks.effects[0]!()
		await prepare()
		expect(mocks.initialize).not.toHaveBeenCalled()
	})
})
