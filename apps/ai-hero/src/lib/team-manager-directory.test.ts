import { describe, expect, it } from 'vitest'

import {
	getTeamManagerOrganizationsForMember,
	type TeamManagerDirectoryDataSource,
	type TeamManagerOrganization,
} from './team-manager-directory'

const organizations: TeamManagerOrganization[] = [
	{
		id: 'org-a',
		name: 'Org A',
		managers: [],
		pendingInvitations: [],
	},
	{
		id: 'org-b',
		name: 'Org B',
		managers: [],
		pendingInvitations: [],
	},
]

function source(role: string): TeamManagerDirectoryDataSource {
	return {
		loadMembershipsForUser: async () => [
			{
				organizationId: 'org-a',
				organizationMembershipRoles: [
					{
						active: true,
						deletedAt: null,
						role: { active: true, deletedAt: null, name: role },
					},
				],
			},
		],
		loadOrganizationsForIds: async () => organizations,
	}
}

describe('team manager directory authorization', () => {
	it('returns only organizations managed by a billing admin', async () => {
		const result = await getTeamManagerOrganizationsForMember(
			'user-admin',
			source('billing_admin'),
		)

		expect(result.map(({ id }) => id)).toEqual(['org-a'])
	})

	it('returns no manager directory to a seat learner', async () => {
		await expect(
			getTeamManagerOrganizationsForMember('user-learner', source('learner')),
		).resolves.toEqual([])
	})

	it('returns nothing without an authenticated user', async () => {
		await expect(
			getTeamManagerOrganizationsForMember(null, source('owner')),
		).resolves.toEqual([])
	})
})
