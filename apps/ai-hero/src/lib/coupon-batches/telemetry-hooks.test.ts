import type { ReadableSpan } from '@opentelemetry/sdk-trace-node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { scrubCouponSpans } from './trace-telemetry'

const sentry = vi.hoisted(() => ({
	init: vi.fn(),
	replayIntegration: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => sentry)
beforeEach(() => {
	vi.stubEnv('AIH_COUPON_BATCH_ENABLED', '')
	delete process.env.AIH_COUPON_BATCH_ENABLED
})
afterEach(() => {
	vi.unstubAllEnvs()
})

it('passes normal flag-off Sentry errors, transactions and Replay frames through the installed hooks unchanged', async () => {
	await import('../../../sentry.server.config')
	await import('../../../sentry.edge.config')
	await import('../../../sentry.client.config')
	const normal = {
		request: {
			url: 'https://example.test/api/coursebuilder/redeem/coupon',
			data: { couponId: 'ordinary-free' },
		},
		extra: { state: new Map([['synthetic', 1]]) },
	}
	expect(sentry.init).toHaveBeenCalledTimes(3)
	for (const [config] of sentry.init.mock.calls) {
		expect(config.beforeSend(normal)).toBe(normal)
		expect(config.beforeSendTransaction(normal)).toBe(normal)
	}
	const replay =
		sentry.replayIntegration.mock.calls[0]?.[0].beforeAddRecordingEvent
	const normalFrame = {
		type: 4,
		data: { href: 'https://example.test/cohorts/c5?code=normal' },
	}
	expect(replay(normalFrame)).toBe(normalFrame)
	expect(
		replay({
			...normalFrame,
			data: { href: `https://example.test/?code=c5comp_${'a'.repeat(40)}` },
		}),
	).toBeNull()
})

it('passes the flag-off OTel export batch and original span through by identity', () => {
	const span = {
		name: 'POST /api/coursebuilder/redeem/coupon',
		attributes: { 'http.request.body': 'normal synthetic claim' },
		events: [],
		links: [],
		status: { code: 0 },
	} as unknown as ReadableSpan
	const batch = [span]
	expect(scrubCouponSpans(batch)).toBe(batch)
	expect(scrubCouponSpans(batch)[0]).toBe(span)
})
