import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('@/config')
// Importing shared config must not validate unrelated Next application secrets.
vi.mock('@/env.mjs', () => {
	throw new Error('Next env module must not be loaded')
})
afterEach(() => {
	vi.resetModules()
	vi.unstubAllEnvs()
})

describe('shared site config', () => {
	it('reads the public URL directly for non-Next consumers', async () => {
		vi.stubEnv('NEXT_PUBLIC_URL', 'https://example.test')
		expect((await import('./config')).default.siteUrl).toBe(
			'https://example.test',
		)
	})
	it('fails clearly when the public URL is missing', async () => {
		vi.stubEnv('NEXT_PUBLIC_URL', '')
		delete process.env.NEXT_PUBLIC_URL
		await expect(import('./config')).rejects.toThrow(
			'NEXT_PUBLIC_URL is required',
		)
	})
	it('fails clearly when the public URL is invalid', async () => {
		vi.stubEnv('NEXT_PUBLIC_URL', 'not-a-url')
		await expect(import('./config')).rejects.toThrow(
			'NEXT_PUBLIC_URL must be an absolute HTTP(S) URL',
		)
	})
})
