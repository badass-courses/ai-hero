import { afterEach, expect, it, vi } from 'vitest'

import { partyProvider } from './party-provider'

afterEach(() => {
	vi.unstubAllGlobals()
})

it('broadcasts resolve without touching the network', async () => {
	const fetchSpy = vi.fn()
	vi.stubGlobal('fetch', fetchSpy)

	await expect(
		partyProvider.broadcastMessage({
			body: { name: 'videoResource.created' },
			roomId: 'video-resource-id',
		}),
	).resolves.toBe('')
	expect(fetchSpy).not.toHaveBeenCalled()
})
