import { expect, it, vi } from 'vitest'
import * as Sentry from '@sentry/nextjs'
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { scrubCouponSpan } from './trace-telemetry'
import { scrubCouponTelemetry } from './telemetry'

it('strips private API bodies and redacts C5 bearers from request, span and replay URLs', () => {
	const bearer = 'c5comp_' + 'a'.repeat(40)
	const original = {
		transaction: 'POST /api/commerce/coupon-batches/export',
		request: {
			url: '/api/commerce/coupon-batches/export',
			data: { secret: 'export payload' },
			headers: { authorization: 'synthetic pat' },
		},
		spans: [
			{
				name: 'POST /api/coursebuilder/redeem/coupon',
				data: { 'http.request.body': 'synthetic free claim' },
			},
		],
		breadcrumbs: [{ url: `https://example.test/cohorts/c5?code=${bearer}` }],
	}
	const scrubbed = scrubCouponTelemetry(original)
	expect(JSON.stringify(scrubbed)).not.toMatch(
		/export payload|synthetic pat|synthetic free claim|c5comp_/,
	)
	expect(scrubbed.transaction).toBe(original.transaction)
	expect(scrubbed.breadcrumbs[0]?.url).toContain('[c5-comp-selector]')
	expect(original.request.data.secret).toBe('export payload')
})

it('scrubs the captured Sentry SDK envelope before the transport sees it', async () => {
	const send = vi.fn(async (envelope: unknown) => {
		void envelope
		return { statusCode: 200 }
	})
	const bearer = 'c5comp_' + 'b'.repeat(40)
	Sentry.init({
		dsn: 'https://synthetic@example.test/1',
		defaultIntegrations: false,
		skipOpenTelemetrySetup: true,
		beforeSend: (event) => scrubCouponTelemetry(event),
		transport: () => ({ send, flush: async () => true }),
	})
	try {
		Sentry.captureEvent({
			message: `failed on ${bearer}`,
			request: {
				url: 'https://example.test/api/commerce/coupon-batches/export',
				data: 'private fixture',
			},
			extra: {
				error: new Error(bearer),
				url: new URL(`https://example.test/?code=${bearer}`),
			},
		})
		expect(await Sentry.flush(2000)).toBe(true)
		const exported = JSON.stringify(send.mock.calls)
		expect(exported).toContain('failed on [c5-comp-selector]')
		expect(exported).not.toMatch(/c5comp_|private fixture/)
	} finally {
		await Sentry.close(2000)
	}
})

it('scrubs a real SDK ReadableSpan and leaves context and timing usable', async () => {
	const exporter = new InMemorySpanExporter()
	const provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	})
	try {
		const code = 'c5comp_' + 'c'.repeat(40)
		const span = provider
			.getTracer('fixture')
			.startSpan('POST /api/coursebuilder/redeem/coupon', {
				attributes: {
					'http.request.body': 'private body',
					'url.full': `https://example.test/?code=${code}`,
				},
			})
		span.addEvent(`fixture ${code}`)
		span.end()
		await provider.forceFlush()
		const original = exporter.getFinishedSpans()[0]!
		const scrubbed = scrubCouponSpan(original)
		expect(scrubbed.spanContext()).toEqual(span.spanContext())
		expect(scrubbed.duration).toEqual(original.duration)
		expect(JSON.stringify([scrubbed.attributes, scrubbed.events])).not.toMatch(
			/c5comp_|private body/,
		)
	} finally {
		await provider.shutdown()
	}
})
