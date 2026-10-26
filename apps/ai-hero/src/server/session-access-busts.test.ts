import { describe, expect, it, vi } from 'vitest'

import { withSessionAccessBusts } from './session-access-busts'

function adapterHarness() {
	const calls: string[] = []
	const adapter = {
		addMemberToOrganization: vi.fn(async (options: { userId: string } & Record<string, unknown>) => {
			calls.push('addMemberToOrganization')
			return { id: 'membership-1', userId: options.userId }
		}),
		removeMemberFromOrganization: vi.fn(async (_options: Record<string, unknown>) => {
			calls.push('removeMemberFromOrganization')
		}),
		addRoleForMember: vi.fn(async (_options: Record<string, unknown>) => {
			calls.push('addRoleForMember')
		}),
		removeRoleForMember: vi.fn(async (_options: Record<string, unknown>) => {
			calls.push('removeRoleForMember')
		}),
		getUserById: vi.fn(),
	}
	const bustUser = vi.fn(async (userId: string) => {
		calls.push(`bust:${userId}`)
	})
	const findMembershipUserId = vi.fn(async (membershipId: string) =>
		membershipId === 'membership-1' ? 'user-1' : null,
	)
	// The wrapper replaces methods in place, like the coupon guard does.
	const originals = { ...adapter }
	const wrapped = withSessionAccessBusts(adapter, {
		bustUser,
		findMembershipUserId,
	})
	return { adapter: originals, wrapped, bustUser, findMembershipUserId, calls }
}

describe('withSessionAccessBusts', () => {
	it('busts the member after membership writes', async () => {
		const { wrapped, calls } = adapterHarness()
		await expect(
			wrapped.addMemberToOrganization({
				organizationId: 'org-1',
				userId: 'user-1',
				invitedById: 'user-1',
			}),
		).resolves.toEqual({ id: 'membership-1', userId: 'user-1' })
		await wrapped.removeMemberFromOrganization({
			organizationId: 'org-1',
			userId: 'user-2',
		})
		expect(calls).toEqual([
			'addMemberToOrganization',
			'bust:user-1',
			'removeMemberFromOrganization',
			'bust:user-2',
		])
	})

	it('resolves the member user for role writes', async () => {
		const { wrapped, calls, findMembershipUserId } = adapterHarness()
		await wrapped.addRoleForMember({
			organizationId: 'org-1',
			memberId: 'membership-1',
			role: 'owner',
		})
		await wrapped.removeRoleForMember({
			organizationId: 'org-1',
			memberId: 'membership-1',
			role: 'owner',
		})
		await wrapped.addRoleForMember({
			organizationId: 'org-1',
			memberId: 'unknown',
			role: 'owner',
		})
		expect(findMembershipUserId).toHaveBeenCalledTimes(3)
		expect(calls).toEqual([
			'addRoleForMember',
			'bust:user-1',
			'removeRoleForMember',
			'bust:user-1',
			'addRoleForMember',
		])
	})

	it('still busts when the write throws, and rethrows', async () => {
		const { adapter, wrapped, bustUser } = adapterHarness()
		adapter.addMemberToOrganization.mockRejectedValueOnce(new Error('deadlock'))
		await expect(
			wrapped.addMemberToOrganization({ organizationId: 'org-1', userId: 'user-1' }),
		).rejects.toThrow('deadlock')
		expect(bustUser).toHaveBeenCalledWith('user-1')
	})

	it('never fails a role write because the lookup failed', async () => {
		const { wrapped, findMembershipUserId } = adapterHarness()
		findMembershipUserId.mockRejectedValueOnce(new Error('db down'))
		await expect(
			wrapped.addRoleForMember({
				organizationId: 'org-1',
				memberId: 'membership-1',
				role: 'owner',
			}),
		).resolves.toBeUndefined()
	})

	it('leaves other adapter methods alone', () => {
		const { adapter, wrapped } = adapterHarness()
		expect(wrapped.getUserById).toBe(adapter.getUserById)
	})
})
