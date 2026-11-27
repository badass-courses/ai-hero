import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination'
import { afterEach, expect, it, vi } from 'vitest'
import config from '../../../next.config.mjs'

afterEach(() => {
	vi.unstubAllEnvs()
})

it('does not add coupon privacy headers to ordinary flag-off cohort requests', async () => {
	vi.stubEnv('AIH_COUPON_BATCH_ENABLED', '')
	delete process.env.AIH_COUPON_BATCH_ENABLED
	const rule = (await config.headers?.())?.find(
		(candidate) => candidate.source === '/cohorts/:slug',
	)
	if (!rule || !('has' in rule) || !rule.has)
		throw new Error('missing comp header rule')
	const request = new IncomingMessage(new Socket())
	for (const query of [
		{},
		{ code: 'ordinary-free' },
		{ code: 'c5comp_invalid' },
	]) {
		expect(matchHas(request, query, rule.has)).toBe(false)
	}
	expect(
		matchHas(request, { code: `c5comp_${'a'.repeat(40)}` }, rule.has),
	).not.toBe(false)
	expect(rule.headers).toContainEqual({
		key: 'Cache-Control',
		value: 'private, no-store',
	})
})
