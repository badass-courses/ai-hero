import { env } from '@/env.mjs'
import { POST as authPOST } from '@/server/auth'
import { createMagicLinkConfirmHandler } from '@/server/magic-link-confirmation'
import { withSkill } from '@/server/with-skill'

export const POST = withSkill(
	createMagicLinkConfirmHandler(authPOST, {
		secret: env.NEXTAUTH_SECRET ?? '',
	}),
)
