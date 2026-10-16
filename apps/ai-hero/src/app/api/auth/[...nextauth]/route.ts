import { env } from '@/env.mjs'
import { auth, GET as authGET, POST as authPOST } from '@/server/auth'
import { createMagicLinkGetHandler } from '@/server/magic-link-confirmation'
import { withSkill } from '@/server/with-skill'

export const GET = withSkill(
	createMagicLinkGetHandler(authGET, {
		secret: env.NEXTAUTH_SECRET ?? '',
		siteUrl: env.NEXT_PUBLIC_URL,
		signedInEmail: async () => (await auth())?.user?.email,
	}),
)
export const POST = withSkill(authPOST)
