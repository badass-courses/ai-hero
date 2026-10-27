import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	initBotId: vi.fn(),
	sdkImported: vi.fn(),
}))
vi.mock('botid/client/core', () => {
	mocks.sdkImported()
	return { initBotId: mocks.initBotId }
})

async function initialize() {
	const { initializeSubscribeBotProtection } =
		await import('./subscribe-bot-client')
	return initializeSubscribeBotProtection()
}

describe('form-local BotID initializer', () => {
	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		mocks.fetch.mockResolvedValue(Response.json({ enabled: false }))
		vi.stubGlobal('fetch', mocks.fetch)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('off fetches the cached mode but never initializes the SDK', async () => {
		await initialize()
		expect(mocks.fetch).toHaveBeenCalledWith(
			'/api/subscribe-bot-mode',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(mocks.initBotId).not.toHaveBeenCalled()
		expect(mocks.sdkImported).not.toHaveBeenCalled()
	})

	it('enabled initializes only once across concurrent form mounts', async () => {
		mocks.fetch.mockImplementation(async () => Response.json({ enabled: true }))
		await Promise.all([initialize(), initialize()])
		expect(mocks.initBotId).toHaveBeenCalledTimes(1)
		expect(mocks.initBotId).toHaveBeenCalledWith({
			protect: [
				{
					path: '/api/coursebuilder/subscribe-to-list/convertkit',
					method: 'POST',
				},
			],
		})
	})

	it('a later form mount can discover on after an off mount', async () => {
		await initialize()
		mocks.fetch.mockResolvedValueOnce(Response.json({ enabled: true }))
		await initialize()
		expect(mocks.initBotId).toHaveBeenCalledTimes(1)
	})

	it.each([{ enabled: false }, { enabled: 'true' }, { mode: 'enforce' }, {}])(
		'does not initialize for a non-enabled discovery response %j',
		async (payload) => {
			mocks.fetch.mockResolvedValueOnce(Response.json(payload))
			await initialize()
			expect(mocks.initBotId).not.toHaveBeenCalled()
		},
	)

	it('fails open when mode discovery is unavailable or malformed', async () => {
		mocks.fetch.mockRejectedValueOnce(new Error('unavailable'))
		await expect(initialize()).resolves.toBeUndefined()
		mocks.fetch.mockResolvedValueOnce(new Response('invalid JSON'))
		await expect(initialize()).resolves.toBeUndefined()
		expect(mocks.initBotId).not.toHaveBeenCalled()
	})
})
