import { beforeEach, describe, expect, it, vi } from 'vitest'

const { can, execute, getServerAuthSession } = vi.hoisted(() => ({
	can: vi.fn(),
	execute: vi.fn(),
	getServerAuthSession: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/server/auth', () => ({ getServerAuthSession }))

import { listImageResources } from './image-resource-query'

const user = { id: 'editor_test' }

describe('listImageResources', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it.each([
		{ session: null, allowed: true },
		{ session: { user }, allowed: false },
	])('rejects callers without a session or update permission before querying', async ({
		session,
		allowed,
	}) => {
		can.mockReturnValue(allowed)
		getServerAuthSession.mockResolvedValue({ session, ability: { can } })

		await expect(listImageResources({ limit: 60 })).rejects.toThrow(
			new Error('Unauthorized'),
		)
		expect(execute).not.toHaveBeenCalled()
	})

	it('returns images for a signed-in editor with update permission', async () => {
		can.mockReturnValue(true)
		getServerAuthSession.mockResolvedValue({ session: { user }, ability: { can } })
		const image = { id: 'image_test', url: 'https://example.test/image.png' }
		execute.mockResolvedValue({ rows: [image] })

		await expect(listImageResources({ limit: 60 })).resolves.toEqual([image])
		expect(can).toHaveBeenCalledWith('update', 'Content')
		expect(execute).toHaveBeenCalledOnce()
	})
})
