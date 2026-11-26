import { scrubCouponTelemetry } from './lib/coupon-batches/telemetry'

declare global {
	// eslint-disable-next-line no-var
	var __aiHeroAxiomOtelRegistered: boolean | undefined
}

async function registerAxiomTracing() {
	if (globalThis.__aiHeroAxiomOtelRegistered) return

	const token = process.env.AXIOM_TOKEN
	const dataset =
		process.env.AXIOM_DATASET || process.env.NEXT_PUBLIC_AXIOM_DATASET

	if (!token || !dataset) return

	const host = process.env.AXIOM_HOST || 'api.axiom.co'

	const [
		{ OTLPTraceExporter },
		{ resourceFromAttributes },
		{ BatchSpanProcessor, NodeTracerProvider },
		{ ATTR_SERVICE_NAME },
	] = await Promise.all([
		import('@opentelemetry/exporter-trace-otlp-http'),
		import('@opentelemetry/resources'),
		import('@opentelemetry/sdk-trace-node'),
		import('@opentelemetry/semantic-conventions'),
	])

	const axiomExporter = new OTLPTraceExporter({
		url: `https://${host}/v1/traces`,
		headers: {
			Authorization: `Bearer ${token}`,
			'X-Axiom-Dataset': dataset,
		},
	})
	const provider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: 'ai-hero',
			'deployment.environment.name':
				process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
		}),
		spanProcessors: [
			new BatchSpanProcessor({
				export: (spans, done) =>
					axiomExporter.export(
						spans.map(
							(span) =>
								new Proxy(span, {
									get(target, property) {
										const value = Reflect.get(target, property, target)
										if (
											property === 'attributes' ||
											property === 'events' ||
											property === 'status' ||
											property === 'name' ||
											property === 'links'
										)
											return scrubCouponTelemetry(value)
										return typeof value === 'function'
											? value.bind(target)
											: value
									},
								}),
						),
						done,
					),
				shutdown: () => axiomExporter.shutdown(),
			}),
		],
	})

	provider.register()
	globalThis.__aiHeroAxiomOtelRegistered = true
}

export async function register() {
	if (process.env.NEXT_RUNTIME === 'nodejs') {
		await Promise.all([
			import('../sentry.server.config'),
			registerAxiomTracing(),
		])
	}

	if (process.env.NEXT_RUNTIME === 'edge') {
		await import('../sentry.edge.config')
	}
}
