import type { ZodType } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ key: undefined as ZodType | undefined }))
vi.mock('@t3-oss/env-nextjs', () => ({
	createEnv: (options: { server: { INTEGRATION_TOKEN_KEY: ZodType } }) => {
		captured.key = options.server.INTEGRATION_TOKEN_KEY
		return {}
	},
}))

// Load the real env declaration, not setup.ts's env fixture. Capture the schema
// without evaluating unrelated required production variables or contacting IO.
await vi.importActual('@/env.mjs')

describe('INTEGRATION_TOKEN_KEY deploy validation', () => {
	afterEach(() => { vi.unstubAllEnvs() })

	it.each(['bad-key', ''])(
		'rejects a present invalid key during env import even when general validation is skipped',
		async (value) => {
			vi.resetModules()
			vi.stubEnv('SKIP_ENV_VALIDATION', '1')
			vi.stubEnv('INTEGRATION_TOKEN_KEY', value)
			await expect(vi.importActual('@/env.mjs')).rejects.toThrow(
				'INTEGRATION_TOKEN_KEY must be 32 bytes encoded as base64',
			)
		},
	)
	it('remains optional and accepts a canonical base64 32-byte key', () => {
		expect(captured.key!.safeParse(undefined).success).toBe(true)
		expect(
			captured.key!.safeParse(Buffer.alloc(32, 7).toString('base64')).success,
		).toBe(true)
	})
	it.each([
		'',
		'not-base64',
		Buffer.alloc(31).toString('base64'),
		Buffer.alloc(33).toString('base64'),
		Buffer.alloc(32).toString('base64') + '\n',
	])('rejects malformed or wrong-length present keys', (value) => {
		const result = captured.key!.safeParse(value)
		expect(result.success).toBe(false)
		if (!result.success)
			expect(result.error.issues[0]!.message).toBe(
				'INTEGRATION_TOKEN_KEY must be 32 bytes encoded as base64',
			)
	})
})
