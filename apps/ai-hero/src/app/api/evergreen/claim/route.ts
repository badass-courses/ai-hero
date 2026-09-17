import {
	drovrEvergreenClaimEnabled,
	drovrEvergreenClaimHandler,
} from '@/server/drovr-evergreen-claim'
import { evergreenClaimHandler } from '@/server/evergreen-claim-composition'

export const dynamic = 'force-dynamic'

/** drovr owns the evergreen claim once its rollout is on; the dormant pilot
 * handler (404 unless separately configured) answers otherwise. */
const handler = (request: Request) =>
	drovrEvergreenClaimEnabled()
		? drovrEvergreenClaimHandler(request)
		: evergreenClaimHandler(request)

export const GET = handler
export const POST = handler
