import { unstable_cache } from 'next/cache'
import { readSubscribeBotModeStrict } from '@/lib/subscribe-bot-mode.server'
import { SUBSCRIBE_BOT_ROUTES } from '@/lib/subscribe-bot-routes'

export const dynamic = 'force-dynamic'

const readCachedEnabled = unstable_cache(
	async () => (await readSubscribeBotModeStrict()) !== 'off',
	['subscribe-bot-client-enabled-v2'],
	{ revalidate: SUBSCRIBE_BOT_ROUTES.modeCacheSeconds },
)

export async function GET() {
	try {
		return Response.json(
			{ enabled: await readCachedEnabled() },
			{
				headers: {
					'Cache-Control': `public, max-age=${SUBSCRIBE_BOT_ROUTES.modeCacheSeconds}, s-maxage=${SUBSCRIBE_BOT_ROUTES.modeCacheSeconds}`,
				},
			},
		)
	} catch {
		return Response.json(
			{},
			{ status: 503, headers: { 'Cache-Control': 'no-store' } },
		)
	}
}
