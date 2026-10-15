import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createUser: vi.fn(),
	ensurePersonalOrganization: vi.fn(),
	inngestSend: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: { createUser: mocks.createUser },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/server/personal-organizations', () => ({
	personalOrganizations: {
		ensurePersonalOrganization: mocks.ensurePersonalOrganization,
	},
}))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn() },
	serializeError: (error: unknown) => String(error),
}))

import { createUserWithPersonalOrg } from './find-or-create-user'

const subscriber = {
	id: 'u1',
	email: 'reader@example.test',
	name: null,
	emailVerified: null,
}

describe('createUserWithPersonalOrg', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.createUser.mockResolvedValue(subscriber)
	})

	it('provisions the personal organization for the user it creates', async () => {
		mocks.ensurePersonalOrganization.mockResolvedValue({})

		const user = await createUserWithPersonalOrg(subscriber)

		expect(user).toBe(subscriber)
		expect(mocks.ensurePersonalOrganization).toHaveBeenCalledWith({
			id: 'u1',
			email: 'reader@example.test',
		})
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('hands a failed provisioning to repair and still returns the user', async () => {
		mocks.ensurePersonalOrganization.mockRejectedValue(new Error('db down'))
		mocks.inngestSend.mockResolvedValue({})

		const user = await createUserWithPersonalOrg(subscriber)

		expect(user).toBe(subscriber)
		expect(mocks.inngestSend).toHaveBeenCalledWith({
			name: 'organization/ensure-personal',
			data: { userId: 'u1', createIfMissing: true },
		})
	})
})
