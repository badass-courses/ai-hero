import { isCourseValuePathIntent } from './learner-flow-classifier'
import type { SideEffectIntent } from './types'
import {
	hasCanonicalValuePathCompletion,
	valuePathIntentCompletedAt,
} from './value-path-completion'

export type ValuePathCompletedAtBackfillRepository = {
	findCompletedValuePathEmailSideEffectIntentsForRepair():
		| Promise<SideEffectIntent[]>
		| SideEffectIntent[]
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> & Pick<SideEffectIntent, 'completedAt'>,
	): Promise<SideEffectIntent> | SideEffectIntent
}

type CompletionEvidence = {
	intent: SideEffectIntent
	completedAt: string
	source: 'legacy-metadata' | 'provider-completion-evidence'
}

export type ValuePathCompletedAtBackfillReceipt = {
	schemaVersion: 'aih.value-path-completed-at-backfill.v2'
	mode: 'dry-run' | 'allow-write'
	generatedAt: string
	strategy: 'canonical-column-from-legacy-or-provider-evidence'
	counts: {
		scanned: number
		courseCompleted: number
		missingCanonicalCompletedAt: number
		repairableFromLegacyMetadata: number
		repairableFromProviderEvidence: number
		unrepairableWithoutEvidence: number
		wouldUpdate: number
		updated: number
		alreadyCanonical: number
	}
}

export async function backfillMissingValuePathCompletedAt(args: {
	repository: ValuePathCompletedAtBackfillRepository
	allowWrite: boolean
	now?: string
}): Promise<ValuePathCompletedAtBackfillReceipt> {
	const generatedAt = args.now ?? new Date().toISOString()
	const scanned =
		await args.repository.findCompletedValuePathEmailSideEffectIntentsForRepair()
	const courseCompleted = scanned.filter(isCourseValuePathIntent)
	const missing = courseCompleted.filter(
		(intent) => !hasCanonicalValuePathCompletion(intent),
	)
	const repairable = missing.flatMap(completionEvidence)
	if (args.allowWrite) {
		for (const { intent, completedAt, source } of repairable) {
			await args.repository.updateSideEffectIntent(intent.id, {
				status: 'completed',
				completedAt,
				gates: intent.gates,
				reviewReasons: intent.reviewReasons,
				metadata: {
					...intent.metadata,
					// Dual-stamp for one release so old code remains rollback-safe.
					completedAt,
					completedAtBackfilledAt: generatedAt,
					completedAtBackfillSource: source,
				},
			})
		}
	}
	const repairableFromLegacyMetadata = repairable.filter(
		(item) => item.source === 'legacy-metadata',
	).length
	const repairableFromProviderEvidence = repairable.filter(
		(item) => item.source === 'provider-completion-evidence',
	).length
	return {
		schemaVersion: 'aih.value-path-completed-at-backfill.v2',
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		generatedAt,
		strategy: 'canonical-column-from-legacy-or-provider-evidence',
		counts: {
			scanned: scanned.length,
			courseCompleted: courseCompleted.length,
			missingCanonicalCompletedAt: missing.length,
			repairableFromLegacyMetadata,
			repairableFromProviderEvidence,
			unrepairableWithoutEvidence: missing.length - repairable.length,
			wouldUpdate: repairable.length,
			updated: args.allowWrite ? repairable.length : 0,
			alreadyCanonical: courseCompleted.length - missing.length,
		},
	}
}

function completionEvidence(intent: SideEffectIntent): CompletionEvidence[] {
	const legacyCompletedAt = valuePathIntentCompletedAt(intent)
	if (legacyCompletedAt) {
		return [{ intent, completedAt: legacyCompletedAt, source: 'legacy-metadata' }]
	}
	const providerCompletedAt = authoritativeProviderCompletedAt(intent)
	return providerCompletedAt
		? [
				{
					intent,
					completedAt: providerCompletedAt,
					source: 'provider-completion-evidence',
				},
			]
		: []
}

function authoritativeProviderCompletedAt(intent: SideEffectIntent) {
	for (const value of [
		intent.metadata.providerCompletedAt,
		providerResultField(intent.metadata.providerResult, 'completedAt'),
		providerResultField(intent.metadata.providerResult, 'completed_at'),
	]) {
		if (typeof value === 'string' && validDate(value)) {
			return new Date(value).toISOString()
		}
	}
	return undefined
}

function providerResultField(value: unknown, key: string) {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)[key]
		: undefined
}

function validDate(value: string) {
	return !Number.isNaN(new Date(value).getTime())
}
