/**
 * Bust the session access cache around the adapter's membership and role
 * writes. Course Builder's purchase, transfer and personal-organization flows
 * all write through these methods, so wrapping them once covers callers that
 * this app does not own. The bust runs even when the write throws, because a
 * partial write can still change what the session should show.
 */

type MembershipWrites = {
	addMemberToOrganization: (options: { userId: string } & any) => Promise<any>
	removeMemberFromOrganization: (
		options: { userId: string } & any,
	) => Promise<any>
	addRoleForMember: (options: { memberId: string } & any) => Promise<any>
	removeRoleForMember: (options: { memberId: string } & any) => Promise<any>
}

export type SessionAccessBustDependencies = {
	bustUser: (userId: string) => Promise<void>
	findMembershipUserId: (membershipId: string) => Promise<string | null>
}

export function createMembershipSessionAccessBust({
	bustUser,
	findMembershipUserId,
}: SessionAccessBustDependencies) {
	return async (membershipId: string) => {
		try {
			const userId = await findMembershipUserId(membershipId)
			if (userId) await bustUser(userId)
		} catch {
			// The lookup failing leaves the entry to expire on its TTL.
		}
	}
}

export function withSessionAccessBusts<TAdapter extends MembershipWrites>(
	adapter: TAdapter,
	dependencies: SessionAccessBustDependencies,
): TAdapter {
	const bustMembership = createMembershipSessionAccessBust(dependencies)
	const addMemberToOrganization = adapter.addMemberToOrganization.bind(adapter)
	const removeMemberFromOrganization =
		adapter.removeMemberFromOrganization.bind(adapter)
	const addRoleForMember = adapter.addRoleForMember.bind(adapter)
	const removeRoleForMember = adapter.removeRoleForMember.bind(adapter)

	return Object.assign(adapter, {
		addMemberToOrganization: async (
			options: Parameters<TAdapter['addMemberToOrganization']>[0],
		) => {
			try {
				return await addMemberToOrganization(options)
			} finally {
				await dependencies.bustUser(options.userId)
			}
		},
		removeMemberFromOrganization: async (
			options: Parameters<TAdapter['removeMemberFromOrganization']>[0],
		) => {
			try {
				return await removeMemberFromOrganization(options)
			} finally {
				await dependencies.bustUser(options.userId)
			}
		},
		addRoleForMember: async (
			options: Parameters<TAdapter['addRoleForMember']>[0],
		) => {
			try {
				return await addRoleForMember(options)
			} finally {
				await bustMembership(options.memberId)
			}
		},
		removeRoleForMember: async (
			options: Parameters<TAdapter['removeRoleForMember']>[0],
		) => {
			try {
				return await removeRoleForMember(options)
			} finally {
				await bustMembership(options.memberId)
			}
		},
	})
}
