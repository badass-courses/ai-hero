import { describe, expect, it, vi } from 'vitest'

import {
	handleOutOfBandUserBoundary,
	handleUserCreatedBoundary,
} from './user-provisioning'

const user = { id: 'user-1', email: 'learner@example.com' }

describe('Auth.js createUser provisioning boundary', () => {
	it('publishes the existing event and provisions once', async () => {
		const publishUserCreated = vi.fn().mockResolvedValue(undefined)
		const provisionPersonalOrganization = vi.fn().mockResolvedValue(undefined)
		const enqueueProvisioningRepair = vi.fn()

		await handleUserCreatedBoundary(user, {
			publishUserCreated,
			provisionPersonalOrganization,
			enqueueProvisioningRepair,
		})

		expect(publishUserCreated).toHaveBeenCalledOnce()
		expect(provisionPersonalOrganization).toHaveBeenCalledOnce()
		expect(provisionPersonalOrganization).toHaveBeenCalledWith(user)
		expect(enqueueProvisioningRepair).not.toHaveBeenCalled()
	})

	it('still provisions when publishing the existing event fails', async () => {
		const error = new Error('event transport unavailable')
		const provisionPersonalOrganization = vi.fn().mockResolvedValue(undefined)

		await expect(
			handleUserCreatedBoundary(user, {
				publishUserCreated: vi.fn().mockRejectedValue(error),
				provisionPersonalOrganization,
				enqueueProvisioningRepair: vi.fn(),
			}),
		).rejects.toBe(error)

		expect(provisionPersonalOrganization).toHaveBeenCalledOnce()
	})

	it('surfaces a repair enqueue failure instead of claiming durability', async () => {
		const enqueueError = new Error('repair transport unavailable')

		await expect(
			handleUserCreatedBoundary(user, {
				publishUserCreated: vi.fn().mockResolvedValue(undefined),
				provisionPersonalOrganization: vi
					.fn()
					.mockRejectedValue(new Error('database unavailable')),
				enqueueProvisioningRepair: vi.fn().mockRejectedValue(enqueueError),
			}),
		).rejects.toBe(enqueueError)
	})

	it('enqueues durable repair and preserves the provisioning failure', async () => {
		const error = new Error('database unavailable')
		const enqueueProvisioningRepair = vi.fn().mockResolvedValue(undefined)

		await expect(
			handleUserCreatedBoundary(user, {
				publishUserCreated: vi.fn().mockResolvedValue(undefined),
				provisionPersonalOrganization: vi.fn().mockRejectedValue(error),
				enqueueProvisioningRepair,
			}),
		).rejects.toBe(error)

		expect(enqueueProvisioningRepair).toHaveBeenCalledOnce()
		expect(enqueueProvisioningRepair).toHaveBeenCalledWith(user.id, error)
	})
})

describe('out-of-band find-or-create provisioning boundary', () => {
	it('provisions once for a newly minted user and returns the resolution', async () => {
		const provisionPersonalOrganization = vi.fn().mockResolvedValue(undefined)
		const enqueueProvisioningRepair = vi.fn()

		const result = await handleOutOfBandUserBoundary(
			async () => ({ user, isNewUser: true }),
			{ provisionPersonalOrganization, enqueueProvisioningRepair },
		)

		expect(result).toEqual({ user, isNewUser: true })
		expect(provisionPersonalOrganization).toHaveBeenCalledOnce()
		expect(provisionPersonalOrganization).toHaveBeenCalledWith(user)
		expect(enqueueProvisioningRepair).not.toHaveBeenCalled()
	})

	it('does not provision when the user already existed', async () => {
		const provisionPersonalOrganization = vi.fn()
		const enqueueProvisioningRepair = vi.fn()

		const result = await handleOutOfBandUserBoundary(
			async () => ({ user, isNewUser: false }),
			{ provisionPersonalOrganization, enqueueProvisioningRepair },
		)

		expect(result).toEqual({ user, isNewUser: false })
		expect(provisionPersonalOrganization).not.toHaveBeenCalled()
		expect(enqueueProvisioningRepair).not.toHaveBeenCalled()
	})

	it('returns the resolution after enqueueing durable repair for a provisioning failure', async () => {
		const enqueueProvisioningRepair = vi.fn().mockResolvedValue(undefined)
		const cause = new Error('database unavailable')

		const result = await handleOutOfBandUserBoundary(
			async () => ({ user, isNewUser: true }),
			{
				provisionPersonalOrganization: vi.fn().mockRejectedValue(cause),
				enqueueProvisioningRepair,
			},
		)

		expect(result).toEqual({ user, isNewUser: true })
		expect(enqueueProvisioningRepair).toHaveBeenCalledOnce()
		expect(enqueueProvisioningRepair).toHaveBeenCalledWith(user.id, cause)
	})

	it('surfaces a repair enqueue failure instead of claiming durability', async () => {
		const enqueueError = new Error('repair transport unavailable')

		await expect(
			handleOutOfBandUserBoundary(async () => ({ user, isNewUser: true }), {
				provisionPersonalOrganization: vi
					.fn()
					.mockRejectedValue(new Error('database unavailable')),
				enqueueProvisioningRepair: vi.fn().mockRejectedValue(enqueueError),
			}),
		).rejects.toBe(enqueueError)
	})
})
