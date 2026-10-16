import { courseBuilderAdapter } from '@/db'
import { ENSURE_PERSONAL_ORGANIZATION_EVENT } from '@/inngest/events/ensure-personal-organization'
import { inngest } from '@/inngest/inngest.server'
import { log, serializeError } from '@/server/logger'
import { personalOrganizations } from '@/server/personal-organizations'
import { handleOutOfBandUserBoundary } from '@/server/user-provisioning'

import type { CourseBuilderUserInput } from '@coursebuilder/core'
import type { PersonalOrganizationUser } from '@coursebuilder/organizations'

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
		personalOrgProvisioning(email),
	)
}

/**
 * App-boundary replacement for `courseBuilderAdapter.createUser`.
 *
 * Course Builder's own handlers (the newsletter subscribe endpoint) mint
 * users through the adapter they are configured with, so the Course Builder
 * config hands them this in place of the bare adapter method. Without it a
 * subscriber has no personal organization and, once signed in, the
 * org-aware middleware sends every gated page to an empty `/organization-list`.
 *
 * @param data - The user row to persist.
 * @returns The persisted user.
 * @throws The repair enqueue error when durable repair cannot be scheduled.
 */
export async function createUserWithPersonalOrg(data: CourseBuilderUserInput) {
	const createUser = courseBuilderAdapter.createUser
	if (!createUser) throw new Error('The adapter cannot create users')
	const { user } = await handleOutOfBandUserBoundary(
		async () => ({
			user: await createUser(data),
			isNewUser: true,
		}),
		personalOrgProvisioning(data.email),
	)
	return user
}

function personalOrgProvisioning(email: string) {
	return {
		provisionPersonalOrganization: (user: PersonalOrganizationUser) =>
			personalOrganizations.ensurePersonalOrganization(user),
		enqueueProvisioningRepair: (userId: string, cause: unknown) => {
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
	}
}
