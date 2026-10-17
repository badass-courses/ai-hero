import { unstable_cache } from 'next/cache'
import { readSubscribeBotMode } from '@/lib/subscribe-bot-mode.server'
import { SUBSCRIBE_BOT_ROUTES } from '@/lib/subscribe-bot-routes'

export const dynamic = 'force-dynamic'

const readCachedMode = unstable_cache(
	readSubscribeBotMode,
	['subscribe-bot-client-mode-v1'],
	{
		revalidate: SUBSCRIBE_BOT_ROUTES.modeCacheSeconds,
	},
)

export async function GET() {
	return Response.json(
		{ mode: await readCachedMode() },
		{
			headers: {
				'Cache-Control': `public, max-age=${SUBSCRIBE_BOT_ROUTES.modeCacheSeconds}, s-maxage=${SUBSCRIBE_BOT_ROUTES.modeCacheSeconds}`,
			},
		},
	)
}
