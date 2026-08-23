import { env } from '@/env.mjs'
import { GET as authGET, POST as authPOST } from '@/server/auth'
import { createMagicLinkGetHandler } from '@/server/magic-link-confirmation'
import { withSkill } from '@/server/with-skill'

export const GET = withSkill(
	createMagicLinkGetHandler(authGET, { secret: env.NEXTAUTH_SECRET ?? '' }),
)
export const POST = withSkill(authPOST)
