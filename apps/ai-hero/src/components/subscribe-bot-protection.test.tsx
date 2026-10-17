import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readMode: vi.fn(), initBotId: vi.fn() }))
vi.mock('@/lib/subscribe-bot-mode.server', () => ({
	readSubscribeBotMode: mocks.readMode,
}))
vi.mock('next/server', () => ({ connection: async () => {} }))
vi.mock('botid/client/core', () => ({ initBotId: mocks.initBotId }))

import { SubscribeBotProtection } from './subscribe-bot-protection'

describe('BotID client loading boundary', () => {
	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		vi.stubGlobal('window', {})
		mocks.readMode.mockResolvedValue('off')
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('off renders no client component or script', async () => {
		expect(await SubscribeBotProtection()).toBeNull()
		expect(mocks.initBotId).not.toHaveBeenCalled()
	})

	it.each(['shadow', 'enforce'])(
		'%s includes the client initializer',
		async (mode) => {
			mocks.readMode.mockResolvedValue(mode)
			const component = await SubscribeBotProtection()
			expect(component).not.toBeNull()
			expect(mocks.initBotId).toHaveBeenCalledTimes(1)
			expect(mocks.initBotId).toHaveBeenCalledWith({
				protect: [
					{
						path: '/api/coursebuilder/subscribe-to-list/convertkit',
						method: 'POST',
					},
				],
			})
		},
	)
})
