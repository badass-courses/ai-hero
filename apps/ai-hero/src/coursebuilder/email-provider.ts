import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import Postmark from 'next-auth/providers/postmark'

import { sendVerificationRequest } from '@coursebuilder/email/send-verification-request'

/**
 * Identity port handed to the magic-link sender.
 *
 * `sendVerificationRequest` resolves the recipient itself and, unless
 * `CREATE_USER_ON_LOGIN=false`, mints unknown emails through
 * `findOrCreateUser` before Auth.js ever runs, so the `createUser` event
 * never fires for them. Route that call through the app boundary so a
 * first-time login-link request provisions the personal organization.
 *
 * The helper is imported lazily: it pulls in the Inngest client, whose
 * config imports this provider, and a static import would evaluate the
 * cycle before `emailProvider` exists.
 */
export const magicLinkIdentity = {
	...courseBuilderAdapter,
	findOrCreateUser: async (email: string, name?: string | null) => {
		const { findOrCreateUserWithPersonalOrg } = await import(
			'@/lib/find-or-create-user'
		)
		return findOrCreateUserWithPersonalOrg(email, name)
	},
}

export const emailProvider = Postmark({
	apiKey: env.POSTMARK_API_KEY,
	from: env.NEXT_PUBLIC_SUPPORT_EMAIL,
	sendVerificationRequest: (params) => {
		return sendVerificationRequest(params, magicLinkIdentity)
	},
})
