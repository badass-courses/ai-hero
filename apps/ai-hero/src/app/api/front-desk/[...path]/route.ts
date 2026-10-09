import { env } from '@/env.mjs'
import { createFrontDeskHandler } from '@ai-hero/front-desk-support'
import { hooks } from '../hooks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = createFrontDeskHandler(hooks, {
	apiKey: env.FRONT_DESK_API_KEY,
})

export const POST = handler.POST
// Every other method goes through the same key gate (503 unconfigured, 401
// without the key, then 405). Exporting them stops Next from answering
// OPTIONS or unsupported methods outside the gate.
export const GET = handler.GET
export const HEAD = handler.GET
export const OPTIONS = handler.GET
export const PUT = handler.GET
export const PATCH = handler.GET
export const DELETE = handler.GET
