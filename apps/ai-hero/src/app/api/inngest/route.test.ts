import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	serve: vi.fn(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() })),
}))

vi.mock('inngest/next', () => ({ serve: mocks.serve }))
vi.mock('@/inngest/inngest.config', () => ({
	inngestConfig: { client: { id: 'ai-hero' }, functions: [] },
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import {
	inngestServeHost,
	PRODUCTION_INNGEST_SERVE_HOST,
} from '@/inngest/serve-host'

describe('Inngest serve host', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		mocks.serve.mockClear()
	})

	it('registers the public www URL in production, never the protected deployment URL', () => {
		expect(PRODUCTION_INNGEST_SERVE_HOST).toBe('https://www.aihero.dev')
		expect(inngestServeHost({ VERCEL_ENV: 'production' })).toBe(
			'https://www.aihero.dev',
		)
	})

	it('leaves previews and local dev on the request host', () => {
		expect(inngestServeHost({ VERCEL_ENV: 'preview' })).toBeUndefined()
		expect(inngestServeHost({})).toBeUndefined()
	})

	it('lets an explicit INNGEST_SERVE_HOST win', () => {
		expect(
			inngestServeHost({
				VERCEL_ENV: 'production',
				INNGEST_SERVE_HOST: ' https://example.test ',
			}),
		).toBe('https://example.test')
	})

	it('serves the route with that host in production', async () => {
		vi.stubEnv('VERCEL_ENV', 'production')
		vi.resetModules()
		await import('./route')
		expect(mocks.serve).toHaveBeenCalledWith(
			expect.objectContaining({ serveHost: 'https://www.aihero.dev' }),
		)
	})
})
