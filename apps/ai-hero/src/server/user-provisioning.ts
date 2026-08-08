import type { PersonalOrganizationUser } from '@coursebuilder/organizations'

export type UserCreatedBoundaryDependencies = {
	provisionPersonalOrganization: (
		user: PersonalOrganizationUser,
	) => Promise<unknown>
	publishUserCreated: () => Promise<unknown>
	enqueueProvisioningRepair: (
		userId: string,
		cause: unknown,
	) => Promise<unknown>
}

/**
 * Runs provisioning after Auth.js has persisted a new identity.
 *
 * Core 2's adapter provisioned the personal organization inside `createUser`.
 * Core 3 removed that bridge, so the app owns the call — without it a new
 * account has no organization and lands in the `/organization-list` loop.
 *
 * The user-created event and provisioning are each attempted once. A failed
 * provisioning attempt is handed to the durable repair workflow before the
 * original failure is rethrown.
 *
 * @param user - The newly persisted Auth.js user identity.
 * @param dependencies - App-owned provisioning and event boundaries.
 * @returns Nothing after provisioning succeeds.
 * @throws The provisioning error after durable repair has been enqueued.
 */
export async function handleUserCreatedBoundary(
	user: PersonalOrganizationUser,
	dependencies: UserCreatedBoundaryDependencies,
): Promise<void> {
	const [userCreatedResult, provisioningResult] = await Promise.allSettled([
		dependencies.publishUserCreated(),
		dependencies.provisionPersonalOrganization(user).catch(async (error) => {
			await dependencies.enqueueProvisioningRepair(user.id, error)
			throw error
		}),
	])

	if (provisioningResult.status === 'rejected') {
		throw provisioningResult.reason
	}

	if (userCreatedResult.status === 'rejected') {
		throw userCreatedResult.reason
	}
}

export type OutOfBandUserBoundaryDependencies = Pick<
	UserCreatedBoundaryDependencies,
	'provisionPersonalOrganization' | 'enqueueProvisioningRepair'
>

/**
 * Runs provisioning for a user resolved outside the Auth.js flow (support
 * escalation, surveys, Kit-cookie progress, purchase transfers).
 *
 * Core 2's `findOrCreateUser` minted the identity through the adapter's
 * `createUser`, which provisioned the personal organization on the way past.
 * Core 3 removed that bridge and the Auth.js createUser event never fires for
 * these users, so the guarantee has to be applied at this boundary instead —
 * without it they reach the org-aware middleware with no organization roles
 * and land in the `/organization-list` loop.
 *
 * Provisioning is attempted once for newly minted users. A failed attempt is
 * handed to the durable repair workflow; once repair is enqueued the resolved
 * user is returned rather than failing the product flow that only needed to
 * resolve an identity. Only a repair enqueue failure propagates, because at
 * that point nothing owns the missing organization.
 *
 * @param resolveUser - Adapter-backed find-or-create identity resolution.
 * @param dependencies - App-owned provisioning and repair boundaries.
 * @returns The resolved user and whether it was newly created.
 * @throws The repair enqueue error when durable repair cannot be scheduled.
 *
 * @example
 * ```ts
 * await handleOutOfBandUserBoundary(() => adapter.findOrCreateUser(email), dependencies)
 * ```
 */
export async function handleOutOfBandUserBoundary<
	TUser extends PersonalOrganizationUser,
>(
	resolveUser: () => Promise<{ user: TUser; isNewUser: boolean }>,
	dependencies: OutOfBandUserBoundaryDependencies,
): Promise<{ user: TUser; isNewUser: boolean }> {
	const result = await resolveUser()

	if (!result.isNewUser) {
		return result
	}

	try {
		await dependencies.provisionPersonalOrganization({
			id: result.user.id,
			email: result.user.email,
		})
	} catch (error) {
		// Repair now durably owns the missing organization, so the product flow
		// that resolved this user proceeds. Only an enqueue failure propagates.
		// The cause travels with it so the failure reaches a log sink.
		await dependencies.enqueueProvisioningRepair(result.user.id, error)
	}

	return result
}
