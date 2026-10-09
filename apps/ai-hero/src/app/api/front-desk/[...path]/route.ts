import { env } from '@/env.mjs'
import { createFrontDeskHandler } from '@ai-hero/front-desk-support'
import { hooks } from '../hooks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const { GET, POST } = createFrontDeskHandler(hooks, {
	apiKey: env.FRONT_DESK_API_KEY,
})
