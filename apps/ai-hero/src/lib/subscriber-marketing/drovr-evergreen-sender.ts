import type { CaptureMarketingRepository } from './capture-contact-event'
import {
	firstActiveStop,
	readActiveContactStops,
	type ContactStopReason,
} from './contact-stop-rule'
import { findJourneyOwnerAssignment } from './drovr-ownership'
import {
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
} from './drovr-shadow-emitter'
import {
	SEND_EVERGREEN_EMAIL_INTENT_TYPE,
	SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
} from './drovr-evergreen'
import { SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE } from './drovr-shadow-newsletter'
import { dispatchDrovrShadowFactSafely } from './drovr-shadow-dispatch'
import type { SideEffectIntent } from './types'
import { createOldNewsletterExitGate, type OldNewsletterExitGate } from './old-newsletter-exit'

/**
 * The sequence sender: drains the evergreen and shadow-newsletter rows the
 * drovr executor endpoint accepted and adds each contact to the row's Kit
 * sequence. One Kit write per row, sequential with pacing, exactly like the
 * skills-course sender. A completed row dispatches its completion fact, which
 * the emitter routes to the owning drovr actor.
 *
 * Failures stay retryable: the row keeps `pending` with an attempt count
 * and the last error until the attempt budget is spent, then it is
 * `failed` and visible. drovr decides *whether* a message should go, with
 * one exception this sender enforces itself: a contact ai-hero knows has
 * stopped (an unsubscribe, bounce or complaint) is never enrolled, whatever
 * drovr's gates said (qi0sd, 2026-09-27: drovr had no suppression row yet).
 */

export type EvergreenSubscribe = (input: {
	listId: string
	listType: 'sequence'
	user: { email: string; name?: string }
}) => Promise<unknown>

export type EvergreenSenderRepository =
	Pick<CaptureMarketingRepository, 'findContactById'> &
	// Required: the stop gate must never pass a contact by default.
	Required<Pick<CaptureMarketingRepository, 'findContactEventsByType'>> &
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

const numberField = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0
const stringField = (value: unknown): string | undefined =>
	typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * What a Kit failure means for the row. Rate limits, Kit outages, and
 * network errors retry: the sequence is non-repeatable (the readback
 * insists on it), so a request that did land cannot send twice. Any
 * other 4xx (inactive sequence, unknown subscriber, bad key) will not
 * change on retry and goes terminal for a human.
 */
type KitFailureVerdict = 'retry' | 'terminal'

function kitFailureVerdict(error: unknown): {
	verdict: KitFailureVerdict
	code: string
} {
	const status =
		error && typeof error === 'object' && 'status' in error
			? (error as { status?: unknown }).status
			: undefined
	if (typeof status !== 'number') return { verdict: 'retry', code: 'network' }
	if (status === 429 || status >= 500) {
		return { verdict: 'retry', code: String(status) }
	}
	return { verdict: 'terminal', code: String(status) }
}

export async function executePendingEvergreenSends(args: {
	repository: EvergreenSenderRepository
	subscribe: EvergreenSubscribe
	oldNewsletterExit?: OldNewsletterExitGate
	limit: number
	now?: () => string
	pacingMs?: number
	sleep?: (ms: number) => Promise<void>
	dispatch?: (intent: SideEffectIntent) => void
	/** Row type to drain; list handoffs and shadow rows add to a Kit
	 * sequence the same way an evergreen message send does. */
	type?:
		| typeof SEND_EVERGREEN_EMAIL_INTENT_TYPE
		| typeof SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE
		| typeof SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE
}): Promise<EvergreenSendResult[]> {
	const now = args.now ?? (() => new Date().toISOString())
	const sleep =
		args.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const dispatch =
		args.dispatch ??
		((intent: SideEffectIntent) =>
			dispatchDrovrShadowFactSafely({
				kind: intent.status === 'failed'
					? 'side-effect-intent-failed'
					: 'side-effect-intent-completed',
				intent,
			}))
	const rows = await args.repository.findPendingSideEffectIntentsByType(
		args.type ?? SEND_EVERGREEN_EMAIL_INTENT_TYPE,
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
		'repository' | 'subscribe' | 'oldNewsletterExit'
	>
	now: string
	dispatch: (intent: SideEffectIntent) => void
}): Promise<EvergreenSendResult> {
	const { row, args, now, dispatch } = input
	const kitSequenceId = stringField(row.metadata.kitSequenceId)
	if (!kitSequenceId) {
		return await giveUp(row, args.repository, now, 'kit-sequence-missing', dispatch)
	}
	const contact = await args.repository.findContactById(row.contactId)
	if (!contact?.email) {
		return await giveUp(row, args.repository, now, 'contact-email-missing', dispatch)
	}
	const stop = await contactStop(args.repository, contact.id)
	if (stop) return await giveUp(row, args.repository, now, stop, dispatch)
	const attempts = numberField(row.metadata.attempts) + 1
	const unclaimed = row.metadata
	if (row.type === SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE ||
		(row.type === SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE && row.metadata.list === 'shadow-newsletter')) {
		try {
			await (args.oldNewsletterExit ?? createOldNewsletterExitGate({ repository: args.repository }))({
				contactId: contact.id, email: contact.email,
			})
		} catch {
			// An exit hold does not spend the provider send retry budget. Keep it
			// pending indefinitely and visible; never dispatch a completion/birth.
			const error = 'old-newsletter-exit-unconfirmed'
			await args.repository.updateSideEffectIntent(row.id, {
				status: 'pending', completedAt: null, gates: row.gates,
				reviewReasons: [...new Set([...row.reviewReasons, error])],
				metadata: { ...unclaimed, lastError: error, exitHeldAt: now },
			})
			return { status: 'retry', intentId: row.id, attempts: numberField(unclaimed.attempts), error }
		}
	}
	const ownedHandoff = await isOwnedShadowNewsletterHandoff(row, args.repository)
	if (row.type === SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE && row.metadata.list === 'shadow-newsletter' && !ownedHandoff) {
		const error = 'shadow-newsletter-owner-missing'
		await args.repository.updateSideEffectIntent(row.id, {
			status: 'pending', completedAt: null, gates: row.gates,
			reviewReasons: [...new Set([...row.reviewReasons, error])],
			metadata: { ...unclaimed, lastError: error, exitHeldAt: now },
		})
		return { status: 'retry', intentId: row.id, attempts: numberField(unclaimed.attempts), error }
	}
	if (ownedHandoff) {
		const completed = await args.repository.updateSideEffectIntent(row.id, {
			status: 'completed',
			completedAt: now,
			gates: row.gates,
			reviewReasons: [],
			metadata: {
				...unclaimed,
				completedAt: now,
				kitSkipped: 'shadow-newsletter-owner-assignment',
			},
		})
		dispatch(completed)
		return { status: 'completed', intentId: row.id, kitSequenceId }
	}
	try {
		await args.subscribe({
			listId: kitSequenceId,
			listType: 'sequence',
			user: { email: contact.email, name: contact.name ?? undefined },
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const failure = kitFailureVerdict(error)
		if (failure.verdict === 'terminal') {
			const failed = await args.repository.updateSideEffectIntent(row.id, {
				status: 'failed',
				completedAt: null,
				gates: row.gates,
				reviewReasons: [...row.reviewReasons, `kit-${failure.code}`],
				metadata: { ...unclaimed, attempts, lastError: message, failedAt: now },
			})
			dispatch(failed)
			return { status: 'failed', intentId: row.id, error: message }
		}
		if (attempts >= EVERGREEN_SEND_MAX_ATTEMPTS) {
			const failed = await args.repository.updateSideEffectIntent(row.id, {
				status: 'failed',
				completedAt: null,
				gates: row.gates,
				reviewReasons: [...row.reviewReasons, 'evergreen-send-exhausted'],
				metadata: { ...unclaimed, attempts, lastError: message, failedAt: now },
			})
			dispatch(failed)
			return { status: 'failed', intentId: row.id, error: message }
		}
		// Kit did not accept the add (or we could not tell); a re-add is a no-op
		// for a non-repeatable sequence, so retrying is the right recovery.
		await args.repository.updateSideEffectIntent(row.id, {
			status: 'pending',
			completedAt: null,
			gates: row.gates,
			reviewReasons: row.reviewReasons,
			metadata: { ...unclaimed, attempts, lastError: message },
		})
		return { status: 'retry', intentId: row.id, attempts, error: message }
	}
	const completed = await args.repository.updateSideEffectIntent(row.id, {
		status: 'completed',
		completedAt: now,
		gates: row.gates,
		reviewReasons: [],
		metadata: { ...unclaimed, completedAt: now },
	})
	dispatch(completed)
	return { status: 'completed', intentId: row.id, kitSequenceId }
}

/**
 * The contact's first active stop, if any: an unsubscribe (unless a later
 * fresh double opt-in lifted it), a bounce or a complaint ai-hero recorded
 * (contact-stop-rule). Any one refuses the row before Kit (or a handoff).
 */
async function contactStop(
	repository: EvergreenSenderRepository,
	contactId: string,
): Promise<ContactStopReason | undefined> {
	return firstActiveStop(await readActiveContactStops(repository, contactId))
}

async function isOwnedShadowNewsletterHandoff(
	row: SideEffectIntent,
	repository: EvergreenSenderRepository,
): Promise<boolean> {
	if (
		row.type !== SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE ||
		row.metadata.list !== 'shadow-newsletter'
	) {
		return false
	}
	return Boolean(
		await findJourneyOwnerAssignment(
			repository,
			row.contactId,
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		),
	)
}

async function giveUp(
	row: SideEffectIntent,
	repository: EvergreenSenderRepository,
	now: string,
	reason: string,
	dispatch: (intent: SideEffectIntent) => void,
): Promise<EvergreenSendResult> {
	const failed = await repository.updateSideEffectIntent(row.id, {
		status: 'failed',
		completedAt: null,
		gates: row.gates,
		reviewReasons: [...row.reviewReasons, reason],
		metadata: { ...row.metadata, lastError: reason, failedAt: now },
	})
	dispatch(failed)
	return { status: 'failed', intentId: row.id, error: reason }
}
