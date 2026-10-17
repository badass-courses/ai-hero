import type { DrovrBatchOutcome } from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { splitUnsubscribedHolds } from './drovr-refusal-outcome'

/** How many held keys one log line names; the count says the rest. */
export const HELD_KEYS_LOGGED = 20

/**
 * Whether a contact is unsubscribed for the hold: the one predicate the
 * straggler retry uses, over the same standing the profile sync reads (a
 * fresh double opt-in lifts it). Reads the standing once per call.
 */
export async function isUnsubscribedForHold<Repository>(
	readStanding: (args: {
		repository: Repository
		contactId: string
	}) => Promise<{ reasons: readonly string[] } | undefined>,
	repository: Repository,
	contactId: string,
): Promise<boolean> {
	return (
		(await readStanding({ repository, contactId }))?.reasons.includes(
			'unsubscribed',
		) ?? false
	)
}

/**
 * The straggler retry's `deliver`: profile, link and offer pushes for a
 * contact who is unsubscribed by now are dropped and counted as rejected,
 * so the chain ends and the version is never acknowledged (the runner acks
 * only when nothing was rejected). Stops, suppressions and births go on to
 * `send`, which owns the outbox.
 *
 * The standing lookup fails open: if it throws, the contact is treated as
 * subscribed and the events are sent, as they were before the hold. A
 * lookup outside `send` must never drop a subscribed contact's events.
 */
export function deliverHoldingUnsubscribed(args: {
	isUnsubscribed: (contactId: string) => Promise<boolean>
	warn: (event: string, fields: Record<string, unknown>) => unknown
	send: (events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
}): (all: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome> {
	return async (all) => {
		const { send, held } = await splitUnsubscribedHolds(
			all,
			async (contactId) => {
				try {
					return await args.isUnsubscribed(contactId)
				} catch (error) {
					await warnSafely(args.warn, 'drovr.contact_sync.hold_lookup_failed', {
						contactId,
						error: error instanceof Error ? error.message : String(error),
					})
					return false
				}
			},
		)
		if (held.length > 0)
			await warnSafely(args.warn, 'drovr.contact_sync.unsubscribed_held', {
				held: held.length,
				idempotencyKeys: held
					.slice(0, HELD_KEYS_LOGGED)
					.map((event) => event.idempotencyKey),
			})
		const outcome: DrovrBatchOutcome =
			send.length === 0 ? { accepted: 0, rejected: 0 } : await args.send(send)
		return { ...outcome, rejected: outcome.rejected + held.length }
	}
}

async function warnSafely(
	warn: (event: string, fields: Record<string, unknown>) => unknown,
	message: string,
	fields: Record<string, unknown>,
) {
	try {
		await warn(message, fields)
	} catch {
		// Logging cannot change the delivery result.
	}
}
