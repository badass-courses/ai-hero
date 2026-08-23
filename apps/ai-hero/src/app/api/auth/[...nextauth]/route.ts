import { GET as authGET, POST as authPOST } from '@/server/auth'
import { createMagicLinkGetHandler } from '@/server/magic-link-confirmation'
import { withSkill } from '@/server/with-skill'

export const GET = withSkill(createMagicLinkGetHandler(authGET))
export const POST = withSkill(authPOST)
