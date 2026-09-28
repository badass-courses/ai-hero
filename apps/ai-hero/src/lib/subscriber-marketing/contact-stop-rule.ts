import type { ContactEventRecord, SideEffectIntent } from './types'

/**
 * The one rule for whether a contact's stop is active (DOI Q5, Joel
 * 2026-09-28: yes, via a fresh double opt-in only).
 *
 * - An unsubscribe is lifted by a later fresh double opt-in confirmation,
 *   recorded as a `contact.resubscribed` ContactEvent at the confirm
 *   (drovr-list-subscribe). A later unsubscribe applies again.
 * - A bounce or a complaint never lifts.
 *
 * Every reader of stop evidence goes through here, so no reader can treat
 * an unsubscribe as permanent again (contact-stop-rule.test.ts pins it).
 */

export const CONTACT_UNSUBSCRIBED_EVENT_TYPE = 'contact.unsubscribed' as const
export const CONTACT_BOUNCED_EVENT_TYPE = 'contact.bounced' as const
export const CONTACT_COMPLAINED_EVENT_TYPE = 'contact.complained' as const
/** Maps to no drovr fact: drovr records its own lift at the confirm. */
export const CONTACT_RESUBSCRIBED_EVENT_TYPE = 'contact.resubscribed' as const

/** The stop ContactEvent types, in the order readers report them. */
export const CONTACT_STOP_EVENT_TYPES = [
	CONTACT_UNSUBSCRIBED_EVENT_TYPE,
	CONTACT_BOUNCED_EVENT_TYPE,
	CONTACT_COMPLAINED_EVENT_TYPE,
] as const

/** Every ContactEvent type the rule reads: the stops and the lift. */
export const CONTACT_STOP_RULE_EVENT_TYPES = [
	...CONTACT_STOP_EVENT_TYPES,
	CONTACT_RESUBSCRIBED_EVENT_TYPE,
] as const

export type ContactStopReason = 'unsubscribed' | 'bounced' | 'complained'

export type ContactStopSignal = {
	kind: ContactStopReason | 'resubscribed'
	/** When it happened (ISO). */
	at: string
}

export type ActiveContactStops = Record<ContactStopReason, boolean>

const SIGNAL_KIND_BY_EVENT_TYPE: ReadonlyMap<
	string,
	ContactStopSignal['kind']
> = new Map([
	[CONTACT_UNSUBSCRIBED_EVENT_TYPE, 'unsubscribed'],
	[CONTACT_BOUNCED_EVENT_TYPE, 'bounced'],
	[CONTACT_COMPLAINED_EVENT_TYPE, 'complained'],
	[CONTACT_RESUBSCRIBED_EVENT_TYPE, 'resubscribed'],
])

export function stopSignalOfEvent(event: {
	eventType: string
	occurredAt: string | Date
}): ContactStopSignal | undefined {
	const kind = SIGNAL_KIND_BY_EVENT_TYPE.get(event.eventType)
	if (!kind) return undefined
	const at =
		event.occurredAt instanceof Date
			? event.occurredAt.toISOString()
			: event.occurredAt
	return { kind, at }
}

/**
 * The rule. An unsubscribe is active unless a lift happened at or after
 * the latest unsubscribe (drovr's rule too: a stop at or before lifted_at
 * is history). An unreadable unsubscribe time keeps it active; an
 * unreadable lift time lifts nothing.
 */
export function activeContactStops(
	signals: Iterable<ContactStopSignal>,
): ActiveContactStops {
	let latestUnsubscribe: number | undefined
	let unsubscribeUnreadable = false
	let latestLift: number | undefined
	const stops: ActiveContactStops = {
		unsubscribed: false,
		bounced: false,
		complained: false,
	}
	for (const signal of signals) {
		const at = Date.parse(signal.at)
		if (signal.kind === 'resubscribed') {
			if (Number.isFinite(at))
				latestLift = latestLift === undefined ? at : Math.max(latestLift, at)
		} else if (signal.kind === 'unsubscribed') {
			if (!Number.isFinite(at)) unsubscribeUnreadable = true
			else
				latestUnsubscribe =
					latestUnsubscribe === undefined ? at : Math.max(latestUnsubscribe, at)
		} else stops[signal.kind] = true
	}
	stops.unsubscribed =
		unsubscribeUnreadable ||
		(latestUnsubscribe !== undefined &&
			(latestLift === undefined || latestUnsubscribe > latestLift))
	return stops
}

/** The first active stop, in reporting order, if any. */
export function firstActiveStop(
	stops: ActiveContactStops,
): ContactStopReason | undefined {
	if (stops.unsubscribed) return 'unsubscribed'
	if (stops.bounced) return 'bounced'
	if (stops.complained) return 'complained'
	return undefined
}

export function isContactStopped(stops: ActiveContactStops): boolean {
	return firstActiveStop(stops) !== undefined
}

/**
 * Stops a provider reported on an earlier course send (the row's
 * `unsubscribed`/`bounced`/`complained` flags), dated when the row finished.
 */
export function stopSignalsOfIntents(
	intents: readonly SideEffectIntent[],
): ContactStopSignal[] {
	const signals: ContactStopSignal[] = []
	for (const row of intents) {
		const at = row.completedAt || row.createdAt
		for (const kind of ['unsubscribed', 'bounced', 'complained'] as const) {
			if (row.metadata[kind] === true || providerFlag(row, kind))
				signals.push({ kind, at })
		}
	}
	return signals
}

export type ContactStopEventReader = {
	findContactEventsByType(
		contactId: string,
		eventType: string,
	): Promise<ContactEventRecord[]> | ContactEventRecord[]
}

/** The rule's ContactEvents for one contact, as signals. */
export async function readContactStopSignals(
	repository: ContactStopEventReader,
	contactId: string,
): Promise<{ signals: ContactStopSignal[]; events: ContactEventRecord[] }> {
	const batches = await Promise.all(
		CONTACT_STOP_RULE_EVENT_TYPES.map(async (eventType) => ({
			eventType,
			events: await repository.findContactEventsByType(contactId, eventType),
		})),
	)
	return {
		events: batches.flatMap((batch) => batch.events),
		// Typed by the query, so a row's own eventType is not trusted twice.
		signals: batches.flatMap(({ eventType, events }) =>
			events.flatMap(
				(event) =>
					stopSignalOfEvent({ eventType, occurredAt: event.occurredAt }) ?? [],
			),
		),
	}
}

/** One contact's active stops from its ContactEvents (plus any extra signals). */
export async function readActiveContactStops(
	repository: ContactStopEventReader,
	contactId: string,
	extra: readonly ContactStopSignal[] = [],
): Promise<ActiveContactStops> {
	const { signals } = await readContactStopSignals(repository, contactId)
	return activeContactStops([...signals, ...extra])
}

/** The rule per key (a contact id, usually) over batch-read rows. */
export function activeContactStopsByKey<Key>(
	rows: Iterable<{ key: Key; signal: ContactStopSignal | undefined }>,
): Map<Key, ActiveContactStops> {
	const signalsByKey = new Map<Key, ContactStopSignal[]>()
	for (const row of rows) {
		if (!row.signal) continue
		const list = signalsByKey.get(row.key) ?? []
		list.push(row.signal)
		signalsByKey.set(row.key, list)
	}
	return new Map(
		[...signalsByKey].map(([key, signals]) => [
			key,
			activeContactStops(signals),
		]),
	)
}

function providerFlag(row: SideEffectIntent, flag: string): boolean {
	const result = row.metadata.providerResult
	return (
		typeof result === 'object' &&
		result !== null &&
		(result as Record<string, unknown>)[flag] === true
	)
}
