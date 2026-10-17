import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	initialize: vi.fn().mockResolvedValue(undefined),
	effects: [] as Array<() => void>,
}))
vi.mock('react', () => ({
	useCallback: (fn: unknown) => fn,
	useEffect: (fn: () => void) => {
		mocks.effects.push(fn)
	},
}))
vi.mock('@/components/subscribe-bot-client', () => ({
	initializeSubscribeBotProtection: mocks.initialize,
}))

import { useSubscribeBotProtection } from './use-subscribe-bot-protection'

describe('subscribe form protection lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.effects.length = 0
	})

	it('starts discovery on form mount and exposes preparation before submit', async () => {
		const prepare = useSubscribeBotProtection()
		expect(mocks.initialize).not.toHaveBeenCalled()
		mocks.effects[0]!()
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
