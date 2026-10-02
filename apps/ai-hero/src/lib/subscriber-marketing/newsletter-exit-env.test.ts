import { expect, it, vi } from 'vitest'
import type { z } from 'zod'
// Test the real feature schemas, without loading unrelated required secrets.
vi.mock('@t3-oss/env-nextjs', () => ({
	createEnv: (options: { server: unknown }) => options.server,
}))
vi.unmock('@/env.mjs')
import { env } from '@/env.mjs'
const schemas = env as unknown as Record<string, z.ZodType>
it.each([
	['TRUE', 'true'],
	['1', 'true'],
	['bad-value', 'false'],
	[undefined, 'false'],
])('readiness flags accept %s without crashing boot', (value, expected) => {
	for (const key of [
		'AIH_SHADOW_NEWSLETTER_EXIT_PRODUCER_READY',
		'AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY',
		'AIH_SHADOW_NEWSLETTER_EXISTING_EXIT_GATE_ENABLED',
	]) {
		expect(schemas[key]?.safeParse(value)).toMatchObject({
			success: true,
			data: expected,
		})
	}
})
