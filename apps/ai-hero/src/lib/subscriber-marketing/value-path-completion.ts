import type { SideEffectIntent } from './types'

type ValuePathCompletionFact = {
	completedAt?: string | Date | null
	metadata?: Record<string, unknown> | null
}

/**
 * The canonical completion fact for a value-path intent.
 *
 * `completedAt` is the durable column. `metadata.completedAt` is read only
 * during the additive migration window so code deployed before the column
 * migration and rows written before the reader cutover remain safe.
 */
export function valuePathIntentCompletedAt(
	intent?: ValuePathCompletionFact,
) {
	return (
		validIso(intent?.completedAt) ??
		validIso(intent?.metadata?.completedAt)
	)
}

export function hasCanonicalValuePathCompletion(
	intent?: Pick<ValuePathCompletionFact, 'completedAt'>,
) {
	return Boolean(validIso(intent?.completedAt))
}

export function isValuePathIntentCompleted(
	intent?: ValuePathCompletionFact,
) {
	return Boolean(valuePathIntentCompletedAt(intent))
}

export function canonicalCompletionForWrite(args: {
	status: SideEffectIntent['status']
	completedAt?: string | null
	metadata: Record<string, unknown>
}) {
	if (args.status !== 'completed') return null
	const completedAt =
		validIso(args.completedAt) ?? validIso(args.metadata.completedAt)
	if (!completedAt) {
		throw new Error('Completed value-path intent is missing completedAt')
	}
	return completedAt
}

function validIso(value: unknown) {
	if (
		!(value instanceof Date) &&
		(typeof value !== 'string' || value.length === 0)
	) {
		return undefined
	}
	const date = value instanceof Date ? value : new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
