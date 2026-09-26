import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

it('loads the app with a malformed Cohort 005 link; link validation belongs to its poll', async () => {
	vi.stubEnv('SKIP_ENV_VALIDATION', '')
	for (const name of [
		'STRIPE_SECRET_TOKEN',
		'STRIPE_WEBHOOK_SECRET',
		'COURSEBUILDER_URL',
		'NEXTAUTH_URL',
		'OPENAI_API_KEY',
		'INNGEST_EVENT_KEY',
		'INNGEST_SIGNING_KEY',
		'MUX_SECRET_KEY',
		'MUX_ACCESS_TOKEN_ID',
		'OPENAI_MODEL_ID',
		'UPSTASH_REDIS_REST_TOKEN',
		'DEEPGRAM_API_KEY',
		'UPLOADTHING_URL',
		'POSTMARK_API_KEY',
		'POSTMARK_WEBHOOK_SECRET',
		'CONVERTKIT_API_SECRET',
		'CONVERTKIT_API_KEY',
		'CLOUDINARY_API_KEY',
		'CLOUDINARY_API_SECRET',
		'NEXT_PUBLIC_APP_NAME',
		'NEXT_PUBLIC_PARTYKIT_ROOM_NAME',
		'NEXT_PUBLIC_PARTY_KIT_URL',
		'NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME',
		'NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET',
		'NEXT_PUBLIC_SUPPORT_EMAIL',
		'NEXT_PUBLIC_SITE_TITLE',
	])
		vi.stubEnv(name, 'test-value')
	vi.stubEnv('DATABASE_URL', 'https://database.example.test')
	vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.test')
	vi.stubEnv('NEXT_PUBLIC_URL', 'https://aihero.example.test')
	vi.stubEnv('CONVERTKIT_SIGNUP_FORM', '123456')
	vi.stubEnv('DROPBOX_SYNC_SHARED_LINK', 'https://www.dropbox.com/crash')
	vi.stubEnv('DROPBOX_SYNC_SHARED_LINK_COHORT_005', 'not-a-url')
	vi.doUnmock('@/env.mjs')
	vi.resetModules()
	const { env } = await import('./env.mjs')
	expect(env.DROPBOX_SYNC_SHARED_LINK_COHORT_005).toBe('not-a-url')
	expect(env.DROPBOX_SYNC_SHARED_LINK).toBe('https://www.dropbox.com/crash')
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
