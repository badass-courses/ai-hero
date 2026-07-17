import { isCourseValuePathIntent } from './learner-flow-classifier'
import type { SideEffectIntent } from './types'
import { hasValidCompletedAt } from './value-path-intent-scan'

export type ValuePathCompletedAtBackfillRepository = {
	findCompletedValuePathEmailSideEffectIntentsForRepair():
		| Promise<SideEffectIntent[]>
		| SideEffectIntent[]
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		>,
	): Promise<SideEffectIntent> | SideEffectIntent
}

export type ValuePathCompletedAtBackfillReceipt = {
	schemaVersion: 'aih.value-path-completed-at-backfill.v1'
	mode: 'dry-run' | 'allow-write'
	generatedAt: string
	strategy: 'authoritative-provider-completion-evidence-only'
	counts: {
		scanned: number
		courseCompleted: number
		missingOrInvalidCompletedAt: number
		repairableFromProviderEvidence: number
		unrepairableWithoutProviderEvidence: number
		wouldUpdate: number
		updated: number
		alreadyStamped: number
	}
}

export async function backfillMissingValuePathCompletedAt(args: {
	repository: ValuePathCompletedAtBackfillRepository
	allowWrite: boolean
	now?: string
}): Promise<ValuePathCompletedAtBackfillReceipt> {
	const generatedAt = args.now ?? new Date().toISOString()
	const scanned = await args.repository.findCompletedValuePathEmailSideEffectIntentsForRepair()
	const courseCompleted = scanned.filter(isCourseValuePathIntent)
	const missing = courseCompleted.filter((intent) => !hasValidCompletedAt(intent))
	const repairable = missing.flatMap((intent) => {
		const completedAt = authoritativeCompletedAt(intent)
		return completedAt ? [{ intent, completedAt }] : []
	})
	if (args.allowWrite) {
		for (const { intent, completedAt } of repairable) {
			await args.repository.updateSideEffectIntent(intent.id, {
				status: intent.status,
				gates: intent.gates,
				reviewReasons: intent.reviewReasons,
				metadata: {
					...intent.metadata,
					completedAt,
					completedAtBackfilledAt: generatedAt,
					completedAtBackfillSource: 'provider-completion-evidence',
				},
			})
		}
	}
	return {
		schemaVersion: 'aih.value-path-completed-at-backfill.v1',
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		generatedAt,
		strategy: 'authoritative-provider-completion-evidence-only',
		counts: {
			scanned: scanned.length,
			courseCompleted: courseCompleted.length,
			missingOrInvalidCompletedAt: missing.length,
			repairableFromProviderEvidence: repairable.length,
			unrepairableWithoutProviderEvidence: missing.length - repairable.length,
			wouldUpdate: repairable.length,
			updated: args.allowWrite ? repairable.length : 0,
			alreadyStamped: courseCompleted.length - missing.length,
		},
	}
}

function authoritativeCompletedAt(intent: SideEffectIntent) {
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
