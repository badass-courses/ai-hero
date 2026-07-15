import type { SideEffectIntent } from './types'

export type IntentReplanRepository = {
	findValuePathEmailSideEffectIntentsByContact(
		contactId: string,
	): Promise<SideEffectIntent[]> | SideEffectIntent[]
	updateSideEffectIntent(
		id: string,
		update: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		>,
	): Promise<unknown> | unknown
}

export type IntentReplanResult = {
	mode: 'value-path-intent-replan'
	allowWrite: boolean
	counts: {
		contacts: number
		blockedIntentsFound: number
		replanned: number
		wouldReplan: number
	}
	results: {
		contactId: string
		intentId: string
		emailResourceId?: string
		previousReviewReasons: string[]
		status: 'replanned' | 'would-replan'
	}[]
}

/**
 * Flip blocked send-value-path-email intents back to pending so the executor
 * re-evaluates them against the CURRENT runtime allowlist. The executor runs
 * the full send gate before any send, so a replan can never bypass a gate —
 * an intent that should stay blocked is re-blocked on the next executor run.
 */
export async function replanBlockedValuePathEmailIntents(args: {
	repository: IntentReplanRepository
	contactIds: string[]
	allowWrite: boolean
	now?: string
}): Promise<IntentReplanResult> {
	const now = args.now ?? new Date().toISOString()
	const results: IntentReplanResult['results'] = []
	for (const contactId of args.contactIds) {
		const intents =
			await args.repository.findValuePathEmailSideEffectIntentsByContact(
				contactId,
			)
		for (const intent of intents) {
			if (intent.status !== 'blocked') continue
			if (args.allowWrite) {
				await args.repository.updateSideEffectIntent(intent.id, {
					status: 'pending',
					gates: intent.gates ?? [],
					reviewReasons: [],
					metadata: {
						...intent.metadata,
						blockedAt: null,
						replannedAt: now,
						replannedFromReviewReasons: intent.reviewReasons ?? [],
					},
				})
			}
			results.push({
				contactId,
				intentId: intent.id,
				emailResourceId: (intent.metadata as { emailResourceId?: string })
					?.emailResourceId,
				previousReviewReasons: intent.reviewReasons ?? [],
				status: args.allowWrite ? 'replanned' : 'would-replan',
			})
		}
	}
	return {
		mode: 'value-path-intent-replan',
		allowWrite: args.allowWrite,
		counts: {
			contacts: args.contactIds.length,
			blockedIntentsFound: results.length,
			replanned: args.allowWrite ? results.length : 0,
			wouldReplan: args.allowWrite ? 0 : results.length,
		},
		results,
	}
}
