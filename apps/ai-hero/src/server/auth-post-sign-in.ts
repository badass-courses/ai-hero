type PostSignInUser = {
	id?: string | null
	email?: string | null
}

type PostSignInDependencies = {
	acceptInvitations: (input: {
		userId: string
		email: string
	}) => Promise<{ acceptedOrganizationIds: string[] }>
	logAccepted: (input: { userId: string; organizationCount: number }) => void
	logFailed: (input: { userId: string; error: string }) => void
}

/**
 * Runs after Auth.js resolves the final adapter user. The invitation service is
 * the idempotency boundary: a repeated sign-in returns no pending organizations
 * and this handler performs no accepted-invitation work.
 */
export function createPostSignInInvitationHandler({
	acceptInvitations,
	logAccepted,
	logFailed,
}: PostSignInDependencies) {
	return async ({ user }: { user: PostSignInUser }): Promise<void> => {
		if (!user.id || !user.email) return

		try {
			const accepted = await acceptInvitations({
				userId: user.id,
				email: user.email,
			})
			if (accepted.acceptedOrganizationIds.length === 0) return

			logAccepted({
				userId: user.id,
				organizationCount: accepted.acceptedOrganizationIds.length,
			})
		} catch (error) {
			logFailed({
				userId: user.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
}
