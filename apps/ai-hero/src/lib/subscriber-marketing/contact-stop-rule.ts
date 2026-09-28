import type { ContactEventRecord, SideEffectIntent } from './types'

/**
 * The one rule for whether a contact's stop is active (DOI Q5, Joel
 * 2026-09-28: yes, via a fresh double opt-in only).
 *
 * - An unsubscribe is lifted by a later fresh double opt-in confirmation,
 *   recorded as a `contact.resubscribed` ContactEvent at the confirm
 *   (drovr-list-subscribe). A later unsubscribe applies again, and a stop
 *   wins a tie (whole seconds).
 * - A bounce or a complaint never lifts.
 * - A lift never revives work planned before it: no course restarts.
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
 * Whole seconds: AI_ContactEvent.occurredAt is TIMESTAMP(0), which rounds a
 * fraction on write, while this floors. Both are monotonic and a rounded
 * stored time is never below the floored one, so for an unsubscribe after
 * a confirmation round(u) >= floor(u) >= floor(c): a mismatch can only turn
 * a lift into a tie (a stop), never lift early.
 */
const wholeSeconds = (iso: string | undefined): number | undefined => {
	const ms = Date.parse(iso ?? '')
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/**
 * The rule, in whole seconds. An unsubscribe is active unless a lift came
 * strictly after the latest unsubscribe: a stop fact wins a tie. An
 * unreadable unsubscribe time keeps it active; an unreadable lift time
 * lifts nothing.
 *
 * With `plannedAt` (when a piece of work was planned), a lift revives only
 * work planned at or after it: work planned before the lift stays stopped,
 * so a re-subscriber's old course never restarts (Joel, 2026-09-28).
 */
export function activeContactStops(
	signals: Iterable<ContactStopSignal>,
	plannedAt?: string,
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
		const at = wholeSeconds(signal.at)
		if (signal.kind === 'resubscribed') {
			if (at !== undefined)
				latestLift = latestLift === undefined ? at : Math.max(latestLift, at)
		} else if (signal.kind === 'unsubscribed') {
			if (at === undefined) unsubscribeUnreadable = true
			else
				latestUnsubscribe =
					latestUnsubscribe === undefined ? at : Math.max(latestUnsubscribe, at)
		} else stops[signal.kind] = true
	}
	const hadUnsubscribe =
		unsubscribeUnreadable || latestUnsubscribe !== undefined
	const lifted =
		!unsubscribeUnreadable &&
		latestUnsubscribe !== undefined &&
		latestLift !== undefined &&
		latestLift > latestUnsubscribe
	const planned = plannedAt === undefined ? undefined : wholeSeconds(plannedAt)
	const revives =
		plannedAt === undefined ||
		(planned !== undefined && latestLift !== undefined && planned >= latestLift)
	stops.unsubscribed = hadUnsubscribe && !(lifted && revives)
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
	options: { extra?: readonly ContactStopSignal[]; plannedAt?: string } = {},
): Promise<ActiveContactStops> {
	const { signals } = await readContactStopSignals(repository, contactId)
	return activeContactStops(
		[...signals, ...(options.extra ?? [])],
		options.plannedAt,
	)
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
