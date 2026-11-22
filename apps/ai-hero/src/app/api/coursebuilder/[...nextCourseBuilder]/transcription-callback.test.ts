import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// sec-059: an unsigned Deepgram callback must not reach Course Builder's webhook.
const mocks = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXTAUTH_SECRET: 'test-nextauth-secret',
		COURSEBUILDER_URL: 'http://localhost',
		DEEPGRAM_API_KEY: 'test-deepgram-key',
	},
}))
vi.mock('@/coursebuilder/course-builder-config', () => ({
	GET: vi.fn(),
	POST: mocks.core,
}))
vi.mock('@/coursebuilder/protect-commerce-request', () => ({
	protectCommerceRequest: async (request: NextRequest) => ({
		request,
		userId: null,
	}),
	authoritativeCheckoutProduct: () => null,
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: { options: { paymentsAdapter: { stripe: {} } } },
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/c5-pricing/server-checkout', () => ({
	expireC5SiblingSessions: vi.fn(),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: vi.fn() }))
vi.mock('@/lib/buy-path/legacy-logger', () => ({
	installBuyPathLegacyAliases: vi.fn(),
}))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }))

import { transcriptProvider } from '@/coursebuilder/transcript-provider'

import { POST } from './route'

const BASE = 'http://localhost/api/coursebuilder/webhook/deepgram'

const callback = (url: string) =>
	new NextRequest(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ results: { channels: [] } }),
	})

const providerUrl = (videoResourceId: string) =>
	transcriptProvider.options.getCallbackUrl!({
		baseUrl: BASE,
		params: { videoResourceId },
	})

beforeEach(() => {
	mocks.core.mockReset()
	mocks.core.mockResolvedValue(new Response(null, { status: 200 }))
})

it('refuses an unsigned transcript callback before Course Builder sees it', async () => {
	const res = await POST(callback(`${BASE}?videoResourceId=video-1`))
	expect(res.status).toBe(401)
	expect(mocks.core).not.toHaveBeenCalled()
})

it("refuses another video's signed callback", async () => {
	const signed = new URL(providerUrl('video-2'))
	signed.searchParams.set('videoResourceId', 'video-1')
	const res = await POST(callback(signed.toString()))
	expect(res.status).toBe(401)
	expect(mocks.core).not.toHaveBeenCalled()
})

it('passes a callback signed by the transcript provider', async () => {
	const res = await POST(callback(providerUrl('video-1')))
	expect(res.status).toBe(200)
	expect(mocks.core).toHaveBeenCalledOnce()
})
