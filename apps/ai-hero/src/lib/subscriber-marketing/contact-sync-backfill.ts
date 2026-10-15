import {
	DROVR_EVENTS_DELIVER_BULK_EVENT,
} from '@/inngest/events/drovr'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

import type { ContactProfileVersion } from './contact-profile-version'
import { parseDrovrProfileSyncConfig } from './drovr-contact-profile-sync-requests'
import {
	buildContactProfileEvents,
	contactProfileContentHash,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import { DOI_REQUESTED_EVENT_TYPE } from './drovr-doi-signup'
import { requireBackfillCanary } from './contact-sync-deltas'
import {
	JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
	journeyOwnerAssignmentJourneyId,
} from './drovr-ownership'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * Contact sync, PR 4: the one-time backfill. It pushes a profile (with its
 * links and offers) for every contact drovr owns a journey for, then a
 * directory stop for every stopped contact, so drovr writes their
 * suppression rows (#324). Resumable through its cursor and idempotent: the
 * profile versions are content-addressed and every key is stable, so a
 * re-run pushes the same events, which drovr dedupes.
 *
 * Runs only on an explicit request, behind AIH_DROVR_PROFILE_SYNC.
 */

export const BACKFILL_STOP_PHASES = [
	'contact.unsubscribed',
	'contact.bounced',
	'contact.complained',
] as const

export type BackfillPhase =
	| 'owners'
	/** Double opt-in signups: drovr runs their double-opt-in journey. */
	| 'double-opt-in'
	| (typeof BACKFILL_STOP_PHASES)[number]
	| 'done'

export type BackfillCursor = {
	phase: BackfillPhase
	afterOccurredAt?: string
	afterId?: string
	/** The next contact's stamp: each contact gets its own instant. */
	nextStampMs?: number
}

export type BackfillRow = {
	id: string
	contactId: string
	eventType: string
	/** For an owner assignment, drovr-owner:<contact>:<journey>. */
	providerEventId?: string
	occurredAt: string
}

export type BackfillPorts = {
	now(): number
	/** ContactEvents of one type after (occurredAt, id), in that order. */
	scanEvents(args: {
		eventType: string
		afterOccurredAt?: string
		afterId?: string
		limit: number
	}): Promise<BackfillRow[]>
	snapshot(
		contactId: string,
		now: string,
	): Promise<ContactProfileSnapshot | undefined>
	versionFor(
		contactId: string,
		contentHash: string,
	): Promise<ContactProfileVersion>
	/** The live dispatch's facts for these stops (stopFactsFor), directory stop included. */
	liveStopFacts(rows: BackfillRow[]): Promise<DrovrShadowEvent[]>
}

export type BackfillPage = {
	phase: Exclude<BackfillPhase, 'done'>
	rows: BackfillRow[]
	events: DrovrShadowEvent[]
	contacts: number
	next: BackfillCursor
}

const PHASES: Exclude<BackfillPhase, 'done'>[] = [
	'owners',
	'double-opt-in',
	...BACKFILL_STOP_PHASES,
]

/**
 * Where a run must stop: a phase it may not enter, or `stops` for all of
 * the stop phases. The run ends `paused` on that phase's cursor and never
 * re-queues, so a slice of the owners phase cannot flow on into the rest.
 */
export type BackfillStopBefore =
	| Exclude<BackfillPhase, 'owners' | 'done'>
	| 'stops'

function stopIndexOf(stopBefore: BackfillStopBefore | undefined) {
	if (stopBefore === undefined) return undefined
	const index = PHASES.indexOf(
		stopBefore === 'stops' ? BACKFILL_STOP_PHASES[0] : stopBefore,
	)
	if (index <= 0)
		throw new Error(
			'BackfillPhase: you requested a phase boundary, and it failed because stopBeforePhase does not follow owners. Accepted: double-opt-in, stops, or a stop event phase. Fix: choose a supported stopBeforePhase. Debug: inspect the saved cursor.',
		)
	return index
}

export async function runContactSyncBackfillPage(
	ports: BackfillPorts,
	cursor: BackfillCursor,
	options: { pageSize?: number } = {},
): Promise<BackfillPage> {
	if (cursor.phase === 'done') throw new Error('backfill is already done')
	const phase = cursor.phase
	const pageSize = options.pageSize ?? 50
	const rows = await ports.scanEvents({
		eventType:
			phase === 'owners'
				? JOURNEY_OWNER_ASSIGNED_EVENT_TYPE
				: phase === 'double-opt-in'
					? DOI_REQUESTED_EVENT_TYPE
					: phase,
		afterOccurredAt: cursor.afterOccurredAt,
		afterId: cursor.afterId,
		limit: pageSize,
	})
	const events: DrovrShadowEvent[] = []
	let contacts = 0
	let nextStampMs = cursor.nextStampMs
	if (phase === 'owners' || phase === 'double-opt-in') {
		const owned = [
			...new Set(
				rows
					// drovr's scope (contract §1): only a sending journey's owners
					// (value path, evergreen offer, newsletter) and double opt-in
					// signups are in the v2 directory; drovr refuses anyone else.
					.filter(
						(row) =>
							phase === 'double-opt-in' ||
							journeyOwnerAssignmentJourneyId({
								providerEventId: row.providerEventId ?? '',
							}) !== undefined,
					)
					.map((row) => row.contactId)
					.filter((contactId) => !isSyntheticPrincipalId(contactId)),
			),
		]
		// The tie rule: each contact is stamped at its own instant, the page's
		// base plus its index, and the next page starts after this one even
		// under a frozen clock. Its links' first issue is that stamp, so 90
		// days later no instant carries a batch for the reconcile to rotate
		// (a same-instant tie over 900 would stop it).
		const stampBase = Math.max(ports.now(), cursor.nextStampMs ?? 0)
		for (const [index, contactId] of owned.entries()) {
			const now = new Date(stampBase + index).toISOString()
			const snapshot = await ports.snapshot(contactId, now)
			// drovr ignores a profile without an email as malformed (§2).
			if (!snapshot || !snapshot.profile.email.trim()) continue
			const { profileVersion, since } = await ports.versionFor(
				contactId,
				contactProfileContentHash(snapshot),
			)
			events.push(
				...buildContactProfileEvents({
					contactId,
					profileVersion,
					...snapshot,
					occurredAt: since,
				}),
			)
			contacts += 1
		}
		nextStampMs = stampBase + owned.length
	} else {
		// Every stop, owned or not: the live facts under the live keys. They
		// include org-aihero's directory stop, from which drovr writes its
		// suppression row (mig-10), so a backfill re-send dedupes against
		// the live one.
		const stopped = rows.filter((row) => !isSyntheticPrincipalId(row.contactId))
		events.push(...(await ports.liveStopFacts(stopped)))
		contacts += stopped.length
	}
	const last = rows.at(-1)
	const next: BackfillCursor =
		rows.length === pageSize && last
			? {
					phase,
					afterOccurredAt: last.occurredAt,
					afterId: last.id,
					...(nextStampMs === undefined ? {} : { nextStampMs }),
				}
			: nextPhase(phase, nextStampMs)
	return { phase, rows, events, contacts, next }
}

function nextPhase(
	phase: Exclude<BackfillPhase, 'done'>,
	nextStampMs: number | undefined,
): BackfillCursor {
	const following = PHASES[PHASES.indexOf(phase) + 1]
	if (!following) return { phase: 'done' }
	return nextStampMs === undefined
		? { phase: following }
		: { phase: following, nextStampMs }
}

/** drovr's cap on one `POST /events/batch`. */
const BULK_BATCH_MAX = 100

// Method syntax on purpose: Inngest's `sendEvent` takes its typed events.
type BackfillStep = {
	run<T>(id: string, callback: () => Promise<T>): Promise<unknown>
	sendEvent(id: string, payload: unknown): Promise<unknown>
}

export type BackfillReceipt =
	| { status: 'dry-run'; rows: number }
	| { status: 'skipped'; reason: string }
	| {
			/** `paused`: a capped run stopped; send its cursor back to resume. */
			status: 'continued' | 'paused' | 'done'
			cursor: BackfillCursor
			pages: number
			contacts: number
			events: number
	  }

/**
 * One run of the backfill: up to `pagesPerRun` pages, each a memoized step,
 * each page's events handed to the bulk delivery lane (its own queue, so
 * live facts never wait behind it) in envelopes of at most 100. Every POST
 * is paced separately by the bulk consumer. An unfinished slice returns a
 * cursor for an explicit operator command; it never continues itself.
 */
export async function runContactSyncBackfill(args: {
	event: {
		data: {
			dryRun?: boolean
			canary?: boolean
			dryRunCount?: number
			canaryConfirmed?: boolean
			cursor?: BackfillCursor
			maxPages?: number
			stopBeforePhase?: BackfillStopBefore
		}
	}
	step: BackfillStep
	env: Readonly<Record<string, string | undefined>>
	ports: BackfillPorts
	pageSize?: number
	pagesPerRun?: number
}): Promise<BackfillReceipt> {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled) return { status: 'skipped', reason: config.reason }
	if (args.event.data.dryRun === true) {
		let rows = 0
		for (const phase of PHASES) {
			let after: BackfillRow | undefined
			for (let page = 0; ; page++) {
				const from = after
				const scanned = (await args.step.run(`count:${phase}:${page}`, () => args.ports.scanEvents({ eventType: phase === 'owners' ? JOURNEY_OWNER_ASSIGNED_EVENT_TYPE : phase === 'double-opt-in' ? DOI_REQUESTED_EVENT_TYPE : phase, afterOccurredAt: from?.occurredAt, afterId: from?.id, limit: 500 }))) as BackfillRow[]
				rows += scanned.length
				if (scanned.length < 500) break
				after = scanned.at(-1)
			}
		}
		return { status: 'dry-run', rows }
	}
	requireBackfillCanary(args.event.data)
	const firstCanary = args.event.data.cursor === undefined
	// A capped run (the first one is a one-page canary) stops after its
	// pages and never re-queues: an operator checks drovr, then sends the
	// receipt's cursor back to go on.
	const { maxPages, stopBeforePhase } = args.event.data
	if (maxPages !== undefined && !(Number.isInteger(maxPages) && maxPages > 0))
		throw new Error('BackfillPages: you requested a slice, and it failed because maxPages is not a positive integer. Accepted: a positive whole number. Fix: set a bounded page count. Debug: inspect the request payload.')
	const stopIndex = stopIndexOf(stopBeforePhase)
	const atStop = (at: BackfillCursor) =>
		stopIndex !== undefined &&
		at.phase !== 'done' &&
		PHASES.indexOf(at.phase) >= stopIndex
	let cursor: BackfillCursor = args.event.data.cursor ?? { phase: 'owners' }
	let pages = 0
	let contacts = 0
	let events = 0
	const pagesPerRun = firstCanary ? 1 : Math.min(args.pagesPerRun ?? 10, maxPages ?? 10)
	for (
		let index = 0;
		index < pagesPerRun && cursor.phase !== 'done' && !atStop(cursor);
		index += 1
	) {
		const from = cursor
		const page = (await args.step.run(`page-${index}`, () =>
			runContactSyncBackfillPage(args.ports, from, {
				pageSize: firstCanary ? 1 : args.pageSize,
			}),
		)) as BackfillPage
		if (page.events.length > 0) {
			const batches = []
			for (let start = 0; start < page.events.length; start += BULK_BATCH_MAX)
				batches.push({
					name: DROVR_EVENTS_DELIVER_BULK_EVENT,
					data: {
						events: page.events.slice(start, start + BULK_BATCH_MAX),
						source: 'contact-sync-backfill',
					},
				})
			await args.step.sendEvent(`deliver-${index}`, batches)
		}
		pages += 1
		contacts += page.contacts
		events += page.events.length
		cursor = page.next
	}
	// Dungeon: every continuation is an explicit operator command. Runs
	// queued before this deploy drain this bounded slice and stop here.
	return {
		status:
			cursor.phase === 'done'
				? 'done'
				: 'paused',
		cursor,
		pages,
		contacts,
		events,
	}
}
