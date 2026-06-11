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

	const provider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: 'ai-hero',
			'deployment.environment.name':
				process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
		}),
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: `https://${host}/v1/traces`,
					headers: {
						Authorization: `Bearer ${token}`,
						'X-Axiom-Dataset': dataset,
					},
				}),
			),
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
