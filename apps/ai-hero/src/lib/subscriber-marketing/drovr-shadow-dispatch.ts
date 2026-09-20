import { DROVR_EVENTS_DELIVER_EVENT } from '@/inngest/events/drovr'
import type { DrovrEventsDeliver } from '@/inngest/events/drovr'
import { log } from '@/server/logger'

import type { EvergreenPitchEntryResult } from './drovr-pitch-entry'
import {
	fanOutOwnedEvents,
	isShadowNewsletterBirth,
} from './drovr-ownership'
import {
	enterEvergreenPitchFromLiveDatabase,
	resolveOwnedContactIds,
} from './drovr-ownership-live'
import {
	emitDrovrShadowEvents,
	mapDrovrShadowFact,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrShadowEvent,
	type DrovrShadowFact,
} from './drovr-shadow-emitter'

/**
 * Durable arrival for drovr facts.
 *
 * The host maps a fact into drovr events synchronously (pure), then hands
 * the batch to Inngest, whose delivery function posts each event with
 * retries. Handing off to Inngest is one local API call; if even that
 * fails the legacy direct post runs as a last resort so the fact is never
 * dropped without an attempt. Nothing here can throw into the host flow:
 * the authoritative write that produced the fact already committed.
 */

type DrovrShadowSend = (payload: DrovrEventsDeliver) => Promise<unknown>

type InngestEventApiAcknowledgement = {
	ids: string[]
	status: 200
}

export async function sendDrovrEventsDeliverViaInngestHttp(
	payload: DrovrEventsDeliver,
	options: {
		eventKey: string
		fetchImpl?: typeof fetch
	},
): Promise<InngestEventApiAcknowledgement> {
	const eventKey = options.eventKey.trim()
	if (!eventKey) throw new Error('Inngest event API key is required')
	const fetchImpl = options.fetchImpl ?? fetch
	let response: Response
	try {
		response = await fetchImpl(
			`https://inn.gs/e/${encodeURIComponent(eventKey)}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			},
		)
	} catch {
		// The request URL contains the event key. Never propagate fetch details.
		throw new Error('Inngest event API request failed')
	}
	if (!response.ok) {
		throw new Error(`Inngest event API returned HTTP ${response.status}`)
	}
	let acknowledgement: unknown
	try {
		acknowledgement = await response.json()
	} catch {
		throw new Error('Inngest event API returned an invalid acknowledgement')
	}
	if (
		typeof acknowledgement !== 'object' ||
		acknowledgement === null ||
		!('status' in acknowledgement) ||
		acknowledgement.status !== 200 ||
		!('ids' in acknowledgement) ||
		!Array.isArray(acknowledgement.ids) ||
		acknowledgement.ids.length === 0 ||
		!acknowledgement.ids.every((id) => typeof id === 'string')
	) {
		throw new Error('Inngest event API returned an invalid acknowledgement')
	}
	return {
		ids: acknowledgement.ids,
		status: 200,
	}
}

type DrovrShadowDispatchOptions = {
	send?: DrovrShadowSend
	/** Direct sender for the fallback; receives the fanned-out batch. */
	fallback?: (events: readonly DrovrShadowEvent[]) => Promise<void>
	/** Test seam for the live eligibility read and ownership stamp. */
	enterPitch?: (args: {
		contactId: string
		completedAt: string
	}) => Promise<EvergreenPitchEntryResult>
	/** Test seam for the all-journey owner read used by fallback fan-out. */
	resolveOwners?: (events: readonly DrovrShadowEvent[]) => Promise<string[]>
	/** Test seam for skills-course ownership of newsletter births. */
	resolveNewsletterOwners?: (
		events: readonly DrovrShadowEvent[],
	) => Promise<string[]>
	/** Evergreen route flag. Defaults to AIH_DROVR_EVERGREEN_ENABLED. */
	evergreenEnabled?: boolean
	warn?: typeof log.warn
}

export async function dispatchDrovrShadowFact(
	fact: DrovrShadowFact,
	options: DrovrShadowDispatchOptions = {},
): Promise<'queued' | 'fallback' | 'nothing'> {
	const evergreenEnabled =
		options.evergreenEnabled ??
		['true', '1'].includes(
			String(process.env.AIH_DROVR_EVERGREEN_ENABLED ?? '')
				.trim()
				.toLowerCase(),
		)
	let evergreenEntryAllowed = true
	if (fact.kind === 'course-completed' && evergreenEnabled) {
		const enterPitch = options.enterPitch ?? enterEvergreenPitchFromLiveDatabase
		const warn = options.warn ?? log.warn
		try {
			const entry = await enterPitch({
				contactId: fact.contactId,
				completedAt: fact.completedAt,
			})
			evergreenEntryAllowed =
				entry.status === 'entered' || entry.status === 'already-entered'
			if (entry.status === 'refused') {
				try {
					await warn('drovr.evergreen.entry_refused', {
						contactId: fact.contactId,
						reason: entry.reason,
					})
				} catch {
					// Logging cannot make an ineligible contact eligible.
				}
			}
		} catch (error) {
			evergreenEntryAllowed = false
			try {
				await warn('drovr.evergreen.entry_failed_closed', {
					contactId: fact.contactId,
					error: error instanceof Error ? error.message : String(error),
				})
			} catch {
				// Logging cannot make an uncertain contact eligible.
			}
		}
	}
	const mappedEvents = mapDrovrShadowFact(fact)
	const events =
		fact.kind === 'course-completed' &&
		evergreenEnabled &&
		!evergreenEntryAllowed
			? mappedEvents.filter(
					(event) => event.journeyId !== DROVR_EVERGREEN_OFFER_JOURNEY_ID,
				)
			: mappedEvents
	if (events.length === 0) return 'nothing'

	// Lazy: the Inngest client pulls the whole middleware graph (db,
	// providers, env) at module load, which the host libraries that call
	// this must not do just to record a fact.
	const send: DrovrShadowSend =
		options.send ??
		(async (payload) => {
			const { inngest } = await import('@/inngest/inngest.server')
			return inngest.send(payload)
		})
	try {
		await send({
			name: DROVR_EVENTS_DELIVER_EVENT,
			data: { events, source: fact.kind },
		})
		return 'queued'
	} catch (error) {
		const warn = options.warn ?? log.warn
		try {
			await warn('drovr.shadow.queue_failed', {
				source: fact.kind,
				eventCount: events.length,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot make delivery authoritative.
		}
		// The fallback must deliver the same batch the durable path would:
		// an owned contact's unsubscribe has to reach the authority tenant
		// whichever road it takes.
		const resolveOwners = options.resolveOwners ?? resolveOwnedContactIds
		const owned = await resolveOwners(events).catch(() => [] as string[])
		const newsletterEvents = events.filter(isShadowNewsletterBirth)
		const resolveNewsletterOwners =
			options.resolveNewsletterOwners ??
			((births: readonly DrovrShadowEvent[]) =>
				resolveOwnedContactIds(births, {
					journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
				}))
		const newsletterOwned = newsletterEvents.length
			? await resolveNewsletterOwners(newsletterEvents).catch(
					() => [] as string[],
				)
			: []
		const fallback = options.fallback ?? emitDrovrShadowEvents
		await fallback(
			fanOutOwnedEvents(
				events,
				new Set(owned),
				new Set(newsletterOwned),
			),
		).catch(() => undefined)
		return 'fallback'
	}
}

export function dispatchDrovrShadowFactSafely(fact: DrovrShadowFact): void {
	try {
		void dispatchDrovrShadowFact(fact).catch(() => undefined)
	} catch {
		// Shadow telemetry must never escape into the authoritative host flow.
	}
}
