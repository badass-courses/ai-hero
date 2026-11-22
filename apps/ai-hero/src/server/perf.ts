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

const DEFAULT_SAMPLE_RATE = 0.02

type TimingData = Record<string, string | boolean | number>

export type Timings<Part extends string> = {
	measure<T>(part: Part, operation: () => Promise<T>): Promise<T>
	finish(data: TimingData, required: readonly Part[]): void
}

export const noTimings: Timings<string> = {
	measure: (_part, operation) => operation(),
	finish: () => {},
}

export function sampleTimings<Part extends string>(
	event: string,
	sampleRate = DEFAULT_SAMPLE_RATE,
): Timings<Part> {
	const rate =
		sampleRate >= 0 && sampleRate <= 1 ? sampleRate : DEFAULT_SAMPLE_RATE
	try {
		if (isProductionBuild() || !(Math.random() < rate)) return noTimings
	} catch {
		return noTimings
	}

	const durations = new Map<Part, number>()
	let finish: { data: TimingData; required: readonly Part[] } | undefined
	let closed = false

	async function emitIfReady() {
		if (
			closed ||
			!finish ||
			!finish.required.every((part) => durations.has(part))
		) {
			return
		}

		closed = true
		try {
			await log.info(event, { ...Object.fromEntries(durations), ...finish.data })
		} catch {
			// The render does not depend on telemetry delivery.
		}
	}

	return {
		measure<T>(part: Part, operation: () => Promise<T>): Promise<T> {
			if (closed) return operation()
			let start: number
			try {
				start = performance.now()
			} catch {
				closed = true
				return operation()
			}

			function stop() {
				if (closed) return
				try {
					durations.set(part, performance.now() - start)
					void emitIfReady()
				} catch {
					closed = true
				}
			}

			try {
				return operation().finally(stop)
			} catch (error) {
				stop()
				throw error
			}
		},
		// Some parts run in streamed children that have not started yet.
		finish(data: TimingData, required: readonly Part[]) {
			if (closed || finish) return
			finish = { data, required }
			void emitIfReady()
		},
	}
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
