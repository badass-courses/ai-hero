export type OrganizationMembershipLike = {
	id: string
	organizationId: string
	role?: string | null
	organization: {
		id?: string | null
		name?: string | null
		fields?: {
			slug?: string | null
		} | null
	}
}
