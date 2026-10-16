/**
 * Which organizations to check for the viewer's cohort access.
 *
 * The cookie or header names the organization the viewer last worked in. When
 * it is missing (a fresh browser, a cleared cookie), the viewer's own
 * memberships stand in: access is per membership, so the viewer's own
 * organizations are the only honest place to look. A named organization is
 * checked first, then the rest, without repeats. Only the viewer's own
 * memberships are ever returned beyond the named one.
 */
export function organizationIdsToCheck(
	currentOrganizationId: string | null | undefined,
	membershipOrganizationIds: (string | null | undefined)[],
): string[] {
	const ordered = [currentOrganizationId, ...membershipOrganizationIds].filter(
		(id): id is string => Boolean(id),
	)
	return Array.from(new Set(ordered))
}
