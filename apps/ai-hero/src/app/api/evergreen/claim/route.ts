import { drovrEvergreenClaimHandler } from '@/server/drovr-evergreen-claim'

export const dynamic = 'force-dynamic'

/** drovr owns the evergreen claim; the handler answers 404 until its
 * rollout is on. */
const handler = (request: Request) => drovrEvergreenClaimHandler(request)

export const GET = handler
export const POST = handler
