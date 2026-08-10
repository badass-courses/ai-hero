import 'server-only'

import { cookies, headers } from 'next/headers'

export async function getCurrentOrganizationId() {
	const organizationIdHeader = (await headers()).get('x-organization-id')

	if (organizationIdHeader) return organizationIdHeader

	return (await cookies()).get('organizationId')?.value ?? null
}
