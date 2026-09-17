import type { CaptureMarketingRepository } from './capture-contact-event'
import { SEND_EVERGREEN_EMAIL_INTENT_TYPE } from './drovr-evergreen'
import { dispatchDrovrShadowFactSafely } from './drovr-shadow-dispatch'
import type { SideEffectIntent } from './types'

/**
 * The evergreen sender: drains `send-evergreen-email` rows the drovr
 * executor endpoint accepted and adds each contact to the slot's Kit
 * sequence. One Kit write per row, sequential with pacing, exactly like
 * the skills-course sender. A completed row dispatches its completion
 * fact, which the emitter routes to the owning drovr actor.
 *
 * Failures stay retryable: the row keeps `pending` with an attempt count
 * and the last error until the attempt budget is spent, then it is
 * `failed` and visible. Nothing here decides *whether* a message should
 * go: drovr decided that when it emitted the intent.
 */

export type EvergreenSubscribe = (input: {
	listId: string
	listType: 'sequence'
	user: { email: string; name?: string }
}) => Promise<unknown>

export type EvergreenSenderRepository = Pick<
	CaptureMarketingRepository,
	'findContactById'
> &
	Required<
		Pick<
			CaptureMarketingRepository,
			'findPendingSideEffectIntentsByType' | 'updateSideEffectIntent'
		>
	>

export type EvergreenSendResult =
	| { status: 'completed'; intentId: string; kitSequenceId: string }
	| { status: 'retry'; intentId: string; attempts: number; error: string }
	| { status: 'failed'; intentId: string; error: string }
	| { status: 'skipped'; intentId: string; reason: string }

export const EVERGREEN_SEND_MAX_ATTEMPTS = 6

/**
 * What a Kit failure means for the row. `rate-limited` and `upstream` are
 * safe to retry: nothing was written. `rejected` will not change on retry.
 * `unresolved` is the dangerous one: the POST may have landed and Kit
 * answered something we could not read, so a retry could enroll the
 * contact twice and send the message again. Both go terminal for a human.
 */
type KitFailureVerdict = 'retry' | 'terminal'

const KIT_FAILURE_CODE =
	/AIH_KIT_SUBSCRIBE_ERROR:(rate-limited|rejected|unresolved|upstream)/

function kitFailureVerdict(error: unknown): {
	verdict: KitFailureVerdict
	code: string
} {
	const fromField =
		error && typeof error === 'object' && 'code' in error
			? (error as { code?: unknown }).code
			: undefined
	const message = error instanceof Error ? error.message : String(error)
	const code =
		typeof fromField === 'string'
			? fromField
			: (KIT_FAILURE_CODE.exec(message)?.[1] ?? 'unknown')
	return {
		verdict:
			code === 'rejected' || code === 'unresolved' ? 'terminal' : 'retry',
		code,
	}
}

const numberField = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0
const stringField = (value: unknown): string | undefined =>
	typeof value === 'string' && value.length > 0 ? value : undefined

export async function executePendingEvergreenSends(args: {
	repository: EvergreenSenderRepository
	subscribe: EvergreenSubscribe
	limit: number
	now?: () => string
	pacingMs?: number
	sleep?: (ms: number) => Promise<void>
	dispatch?: (intent: SideEffectIntent) => void
}): Promise<EvergreenSendResult[]> {
	const now = args.now ?? (() => new Date().toISOString())
	const sleep =
		args.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const dispatch =
		args.dispatch ??
		((intent: SideEffectIntent) =>
			dispatchDrovrShadowFactSafely({
				kind: 'side-effect-intent-completed',
				intent,
			}))
	const rows = await args.repository.findPendingSideEffectIntentsByType(
		SEND_EVERGREEN_EMAIL_INTENT_TYPE,
		args.limit,
	)
	const results: EvergreenSendResult[] = []
	let first = true
	for (const row of rows) {
		if (!first && args.pacingMs) await sleep(args.pacingMs)
		first = false
		results.push(await sendOne({ row, args, now: now(), dispatch }))
	}
	return results
}

async function sendOne(input: {
	row: SideEffectIntent
	args: Pick<
		Parameters<typeof executePendingEvergreenSends>[0],
		'repository' | 'subscribe'
	>
	now: string
	dispatch: (intent: SideEffectIntent) => void
}): Promise<EvergreenSendResult> {
	const { row, args, now, dispatch } = input
	const kitSequenceId = stringField(row.metadata.kitSequenceId)
	if (!kitSequenceId) {
		return await giveUp(row, args.repository, now, 'kit-sequence-missing')
	}
	const contact = await args.repository.findContactById(row.contactId)
	if (!contact?.email) {
		return await giveUp(row, args.repository, now, 'contact-email-missing')
	}
	try {
		await args.subscribe({
			listId: kitSequenceId,
			listType: 'sequence',
			user: { email: contact.email, name: contact.name ?? undefined },
		})
	} catch (error) {
		const attempts = numberField(row.metadata.attempts) + 1
		const message = error instanceof Error ? error.message : String(error)
		const failure = kitFailureVerdict(error)
		if (failure.verdict === 'terminal') {
			await args.repository.updateSideEffectIntent(row.id, {
				status: 'failed',
				completedAt: null,
				gates: row.gates,
				reviewReasons: [...row.reviewReasons, `kit-${failure.code}`],
				metadata: { ...row.metadata, attempts, lastError: message },
			})
			return { status: 'failed', intentId: row.id, error: message }
		}
		if (attempts >= EVERGREEN_SEND_MAX_ATTEMPTS) {
			await args.repository.updateSideEffectIntent(row.id, {
				status: 'failed',
				completedAt: null,
				gates: row.gates,
				reviewReasons: [...row.reviewReasons, 'evergreen-send-exhausted'],
				metadata: { ...row.metadata, attempts, lastError: message },
			})
			return { status: 'failed', intentId: row.id, error: message }
		}
		await args.repository.updateSideEffectIntent(row.id, {
			status: 'pending',
			completedAt: null,
			gates: row.gates,
			reviewReasons: row.reviewReasons,
			metadata: { ...row.metadata, attempts, lastError: message },
		})
		return { status: 'retry', intentId: row.id, attempts, error: message }
	}
	const completed = await args.repository.updateSideEffectIntent(row.id, {
		status: 'completed',
		completedAt: now,
		gates: row.gates,
		reviewReasons: [],
		metadata: { ...row.metadata, completedAt: now },
	})
	dispatch(completed)
	return { status: 'completed', intentId: row.id, kitSequenceId }
}

async function giveUp(
	row: SideEffectIntent,
	repository: EvergreenSenderRepository,
	_now: string,
	reason: string,
): Promise<EvergreenSendResult> {
	await repository.updateSideEffectIntent(row.id, {
		status: 'failed',
		completedAt: null,
		gates: row.gates,
		reviewReasons: [...row.reviewReasons, reason],
		metadata: { ...row.metadata, lastError: reason },
	})
	return { status: 'failed', intentId: row.id, error: reason }
}
