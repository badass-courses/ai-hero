import 'server-only'

import { cookies, headers } from 'next/headers'
import {
	determineOrgAccess,
	type OrganizationRole,
} from '@/utils/determine-org-access'

type OrganizationRoleCandidate = Omit<OrganizationRole, 'organizationId'> & {
	organizationId: string | null
}

export async function getCurrentOrganizationId() {
	const organizationIdHeader = (await headers()).get('x-organization-id')

	if (organizationIdHeader) return organizationIdHeader

	return (await cookies()).get('organizationId')?.value ?? null
}

export function resolveSessionOrganizationId(
	organizationId: string | null,
	organizationRoles: OrganizationRoleCandidate[],
) {
	if (organizationId) return organizationId

	const defaultAccess = determineOrgAccess(
		organizationRoles.filter(
			(role): role is OrganizationRole => role.organizationId !== null,
		),
		undefined,
	)

	return defaultAccess.action === 'SET_OWNER_ORG'
		? (defaultAccess.organizationId ?? null)
		: null
}
