import { createHash } from 'node:crypto'

import {
	CONTACT_SYNC_RETRY_EVENT,
	type DrovrContactSyncRetryRequested,
} from '@/inngest/events/drovr'

import { parseDrovrProfileSyncConfig } from './drovr-contact-profile-sync-requests'
import type {
	DeferredDrovrEvent,
	DrovrBatchOutcome,
} from './drovr-shadow-delivery'
import {
	mapDrovrShadowFact,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import type { ContactRecord } from './types'

export { CONTACT_SYNC_RETRY_EVENT }

/**
 * The contact-sync push contract (§4): an event drovr refused as
 * event-not-live (or cold-start-unhandled) recorded nothing and left its key
 * unconsumed. It is re-sent unchanged, same key, after drovr's daily
 * straggler pass has had a chance to migrate the contact, and again each
 * day until drovr takes it. Never dropped, never re-keyed.
 */
export const STRAGGLER_RETRY_DELAY_MS = 25 * 60 * 60 * 1000

/** A week of daily refusals is worth a look (the contract expects a day). */
export const STRAGGLER_STUCK_AFTER_ATTEMPTS = 7

/**
 * The request is keyed by its events and attempt: Inngest drops a send
 * whose id it saw within 24 h. A late joiner re-pushes its unchanged
 * version (same keys) on every change until drovr migrates it, so this
 * holds one pending retry per contact instead of one per change. The
 * retry's own next attempt is a new id, and so is any changed content.
 */
export function contactSyncRetryRequest(
	items: DeferredDrovrEvent[],
	attempt: number,
	nowMs: number,
): DrovrContactSyncRetryRequested & { id: string; ts: number } {
	const keys = items.map((item) => item.event.idempotencyKey).sort()
	const digest = createHash('sha256').update(keys.join('\0')).digest('hex')
	return {
		name: CONTACT_SYNC_RETRY_EVENT,
		id: `contact-sync-retry:${attempt}:${digest}`,
		ts: nowMs + STRAGGLER_RETRY_DELAY_MS,
		data: { items, attempt },
	}
}

/**
 * The directory birth for a contact drovr has no directory actor for
 * (contract §4, after a 409 cold-start-unhandled): the live feed's own
 * `contact-created` mapping, so shape and key (`directory:seed:<id>`) match
 * the seed and the feed exactly. drovr births an actor only once whatever
 * the key, so it can never double-birth.
 */
export function directoryBirthEvents(args: {
	contact: ContactRecord
	kitSubscriberId?: string
}): DrovrShadowEvent[] {
	return mapDrovrShadowFact({
		kind: 'contact-created',
		contactId: args.contact.id,
		createdAt: args.contact.createdAt,
		sourceLifecycle: args.contact.lifecycle,
		...(args.kitSubscriberId ? { kitSubscriberId: args.kitSubscriberId } : {}),
	})
}

/** The `birth` port: reads each contact and delivers their births together. */
export function createDirectoryBirth(args: {
	findContactById(id: string): Promise<ContactRecord | null | undefined>
	kitSubscriberIdFor(contactId: string): Promise<string | undefined>
	/** Default delivery mode: a failure throws and the step retries. */
	deliver(events: DrovrShadowEvent[]): Promise<unknown>
}): (contactIds: string[]) => Promise<void> {
	return async (contactIds) => {
		const births: DrovrShadowEvent[] = []
		for (const contactId of contactIds) {
			const contact = await args.findContactById(contactId)
			if (!contact) continue
			births.push(
				...directoryBirthEvents({
					contact,
					kitSubscriberId: await args.kitSubscriberIdFor(contactId),
				}),
			)
		}
		if (births.length > 0) await args.deliver(births)
	}
}

/**
 * Refusals as cold-start-unhandled get their contacts' directory actors
 * born, then the same events once more: a birth lands on v2, so the push
 * lands straight away. Never for event-not-live, whose actor exists on v1.
 * Returns what is still refused, for the daily retry.
 */
export async function birthThenRedeliver(args: {
	deferred: DeferredDrovrEvent[]
	step: RetryStep
	birth: (contactIds: string[]) => Promise<void>
	deliver: (events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
}): Promise<{
	deferred: DeferredDrovrEvent[]
	accepted: number
	rejected: number
}> {
	const cold = args.deferred.filter(
		(item) => item.reason === 'cold-start-unhandled',
	)
	if (cold.length === 0)
		return { deferred: args.deferred, accepted: 0, rejected: 0 }
	const contactIds = [...new Set(cold.map((item) => item.event.contactId))]
	await args.step.run('birth-directory', () => args.birth(contactIds))
	const outcome = (await args.step.run('redeliver-after-birth', () =>
		args.deliver(cold.map((item) => item.event)),
	)) as DrovrBatchOutcome
	return {
		deferred: [
			...args.deferred.filter((item) => item.reason !== 'cold-start-unhandled'),
			...(outcome.deferred ?? []),
		],
		accepted: outcome.accepted,
		rejected: outcome.rejected,
	}
}

type RetryStep = {
	run<T>(id: string, callback: () => Promise<T>): Promise<unknown>
	sendEvent(id: string, payload: unknown): Promise<unknown>
}

export type ContactSyncRetryReceipt =
	| { status: 'delivered'; accepted: number; rejected: number }
	| {
			status: 'rescheduled'
			deferred: number
			attempt: number
			reason?: string
	  }

export async function runContactSyncStragglerRetry(args: {
	event: { data: { items: DeferredDrovrEvent[]; attempt: number } }
	step: RetryStep
	env: Readonly<Record<string, string | undefined>>
	now: () => number
	/** Delivers in deferNotLive mode; throws on a transient failure. */
	deliver: (events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
	warn: (event: string, fields: Record<string, unknown>) => unknown
	/** Births these contacts' directory actors (directoryBirthEvents). */
	birth: (contactIds: string[]) => Promise<void>
}): Promise<ContactSyncRetryReceipt> {
	const { items, attempt } = args.event.data
	const nowMs = (await args.step.run('now', async () => args.now())) as number
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled) {
		// A drovr rollback turns the flag off: nothing may land in the
		// window, and nothing is dropped either.
		await args.step.sendEvent(
			'reschedule',
			contactSyncRetryRequest(items, attempt, nowMs),
		)
		return {
			status: 'rescheduled',
			deferred: items.length,
			attempt,
			reason: config.reason,
		}
	}
	const outcome = (await args.step.run('deliver', () =>
		args.deliver(items.map((item) => item.event)),
	)) as DrovrBatchOutcome
	const resolved = await birthThenRedeliver({
		deferred: outcome.deferred ?? [],
		step: args.step,
		birth: args.birth,
		deliver: args.deliver,
	})
	const refused = resolved.deferred
	if (refused.length === 0)
		return {
			status: 'delivered',
			accepted: outcome.accepted + resolved.accepted,
			rejected: outcome.rejected + resolved.rejected,
		}
	if (attempt >= STRAGGLER_STUCK_AFTER_ATTEMPTS)
		await args.warn('drovr.contact_sync.straggler_stuck', {
			attempt,
			reasons: [...new Set(refused.map((item) => item.reason))],
			idempotencyKeys: refused.map((item) => item.event.idempotencyKey),
		})
	await args.step.sendEvent(
		'reschedule',
		contactSyncRetryRequest(refused, attempt + 1, nowMs),
	)
	return {
		status: 'rescheduled',
		deferred: refused.length,
		attempt: attempt + 1,
	}
}
