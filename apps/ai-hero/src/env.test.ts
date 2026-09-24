import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

it('exposes the configured value-path signing secret to server routes', async () => {
	const secret = 'test-value-path-secret-at-least-16-chars'
	vi.stubEnv('SKIP_ENV_VALIDATION', '1')
	vi.stubEnv('AI_HERO_VALUE_PATH_TOKEN_SECRET', secret)
	// The shared Vitest setup mocks @/env.mjs; exercise the real t3 createEnv map.
	vi.doUnmock('@/env.mjs')
	vi.resetModules()

	const { env } = await import('./env.mjs')
	expect(env.AI_HERO_VALUE_PATH_TOKEN_SECRET).toBe(secret)
})
