import { courseBuilderAdapter } from '@/db'
import { ENSURE_PERSONAL_ORGANIZATION_EVENT } from '@/inngest/events/ensure-personal-organization'
import { inngest } from '@/inngest/inngest.server'
import { log, serializeError } from '@/server/logger'
import { personalOrganizations } from '@/server/personal-organizations'
import { handleOutOfBandUserBoundary } from '@/server/user-provisioning'

/**
 * App-boundary replacement for `courseBuilderAdapter.findOrCreateUser`.
 *
 * The adapter persists a bare user row; personal-organization provisioning is
 * app policy applied at the auth boundary (ADR-0012), and the Auth.js
 * createUser event never fires for users minted out-of-band. Always create
 * users through this helper, never through the adapter directly.
 *
 * A provisioning failure is logged and handed to the durable repair workflow;
 * the resolved user is still returned. Only a repair enqueue failure (or the
 * adapter lookup itself failing) rejects.
 *
 * @param email - Email that identifies or creates the user.
 * @param name - Optional display name applied when the user is created.
 * @returns The resolved user and whether it was newly created.
 * @throws The repair enqueue error when durable repair cannot be scheduled.
 *
 * @example
 * ```ts
 * const { user, isNewUser } = await findOrCreateUserWithPersonalOrg(email)
 * ```
 */
export async function findOrCreateUserWithPersonalOrg(
	email: string,
	name?: string | null,
) {
	return handleOutOfBandUserBoundary(
		() => courseBuilderAdapter.findOrCreateUser(email, name),
		{
			provisionPersonalOrganization: (user) =>
				personalOrganizations.ensurePersonalOrganization(user),
			enqueueProvisioningRepair: (userId, cause) => {
				void log.error('user.personal-org-provisioning-failed', {
					userId,
					email,
					error: serializeError(cause),
				})
				return inngest.send({
					name: ENSURE_PERSONAL_ORGANIZATION_EVENT,
					data: { userId, createIfMissing: true },
				})
			},
		},
	)
}
