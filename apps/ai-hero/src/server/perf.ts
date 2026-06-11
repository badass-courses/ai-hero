import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'

import { log, serializeError } from '@/server/logger'

const tracer = trace.getTracer('ai-hero.performance')

function isProductionBuild() {
	return process.env.NEXT_PHASE === 'phase-production-build'
}

function isNextDynamicServerUsageError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes('Dynamic server usage:') &&
		error.message.includes("couldn't be rendered statically")
	)
}

type SpanAttributePrimitive = string | number | boolean

function normalizeSpanAttributes(data: Record<string, unknown>): Attributes {
	const attributes: Attributes = {}

	for (const [key, value] of Object.entries(data)) {
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			attributes[key] = value
			continue
		}

		if (Array.isArray(value)) {
			if (value.every((item) => typeof item === 'string')) {
				attributes[key] = value
				continue
			}

			if (value.every((item) => typeof item === 'number')) {
				attributes[key] = value
				continue
			}

			if (value.every((item) => typeof item === 'boolean')) {
				attributes[key] = value
			}
		}
	}

	return attributes
}

export async function measureIfSlow<T>({
	event,
	spanName = event,
	thresholdMs,
	data = {},
	operation,
}: {
	event: string
	spanName?: string
	thresholdMs: number
	data?: Record<string, unknown>
	operation: () => Promise<T>
}): Promise<T> {
	const startedAt = Date.now()
	const attributes = normalizeSpanAttributes(data)

	return tracer.startActiveSpan(
		spanName,
		{
			attributes,
		},
		async (span): Promise<T> => {
			try {
				const result = await operation()
				const durationMs = Date.now() - startedAt

				span.setAttribute('duration.ms', durationMs)

				if (!isProductionBuild() && durationMs >= thresholdMs) {
					await log.info(event, {
						durationMs,
						...data,
					})
				}

				return result
			} catch (error) {
				const durationMs = Date.now() - startedAt

				span.recordException(
					error instanceof Error ? error : new Error(String(error)),
				)
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				})
				span.setAttribute('duration.ms', durationMs)

				if (!isProductionBuild() && !isNextDynamicServerUsageError(error)) {
					await log.error(`${event}.error`, {
						durationMs,
						...data,
						error: serializeError(error),
					})
				}
				throw error
			} finally {
				span.end()
			}
		},
	) as Promise<T>
}
