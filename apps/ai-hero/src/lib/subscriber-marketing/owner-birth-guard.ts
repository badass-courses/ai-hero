import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

import type { BirthFeedProof } from './drovr-birth-feed'
import type { DrovrEmailDeliveryRead } from './drovr-email-delivery'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	mapDrovrShadowFact,
	type DrovrDeliveryOutcome,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { drovrProblemCodes } from './drovr-stop-verdict'
import type { ContactEventRecord } from './types'

/**
 * The owner-without-birth guard (hawk row 110). An owner assignment is a
 * value-path contact's only authority birth; if its hand-off is lost (six
 * on 2026-09-27, before #326 awaited it) nothing else re-sends it, and the
 * contact never gets lesson one.
 *
 * Hourly, for skills-course owners assigned 1 h to 72 h ago, ask drovr
 * whether lesson one went out (`GET /email-delivery`). Only `not-started`
 * goes further, and only when `GET /contacts` answers 404
 * `contact-not-found` for the value-path journey (no actor snapshot) is
 * the birth lost. Then the original birth, exactly as the live dispatch
 * built it (same key), is posted once, and never again for that owner.
 *
 * Never re-posted: an actor that exists but sent nothing (logged), a stop
 * in ai-hero or on drovr's directory actor, a synthetic principal, an
 * unreadable answer, or an owner already re-posted once.
 *
 * Row 204 widens it to the other owner births. An evergreen owner
 * assignment is the evergreen birth, like the skills-course one, and is
 * judged by its actor alone (there is no lesson one to ask about). A
 * newsletter birth is not its owner assignment (written at signup): it is
 * the owner copy of the birth mapped from the completed shadow-newsletter
 * list intent weeks later, so those intents are scanned, and the birth is
 * rebuilt from the intent exactly as live built it (same key, same zone).
 */

export const OWNER_BIRTH_GUARD_REPOST_CAP = 25
export const OWNER_BIRTH_GUARD_CONFIRMATION_CAP = 25
/** Leaves ample headroom beneath the route's 800s invocation limit. */
export const OWNER_BIRTH_GUARD_PAGE_BUDGET_MS = 5 * 60_000

/**
 * Reserved: drovr sends no such code today. `/events` accepts an event for
 * a suppressed contact and blocks it at the send gate, and its only
 * suppression slug is `confirm-suppressed`, on `/confirm`. So `suppressed`
 * never counts yet (the guard skips a suppressed contact by the
 * directory's state before posting); this reads the code once drovr sends
 * one.
 */
export const DROVR_CONTACT_SUPPRESSED = 'contact-suppressed'
export const OWNER_BIRTH_GUARD_MIN_AGE_MS = 60 * 60 * 1000
export const OWNER_BIRTH_GUARD_MAX_AGE_MS = 72 * 60 * 60 * 1000
export const OWNER_BIRTH_GUARD_JOURNEY_ID = DROVR_SKILLS_COURSE_JOURNEY_ID
/** Journeys whose owner assignment is itself the authority birth. */
export const OWNER_BIRTH_GUARD_OWNER_JOURNEY_IDS = [
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
] as const
const DIRECTORY_JOURNEY_ID = 'contact-directory'
const MAX_PAGES = 200

/** A directory actor in any stop state: drovr's suppression is written. */
const STOPPED_DIRECTORY_STATE = /unsubscrib|bounce|complain|suppress|stop/i

export type DrovrReadBackpressure = {
	status: 429 | 502 | 503 | 504 | '5xx' | 'timeout' | 'page-budget'
	retryAfter?: string
}
export type DrovrReadFailure = {
	ok: false
	reason: string
	backpressure?: DrovrReadBackpressure
}
export type DrovrActorRead =
	| { ok: true; found: false }
	| { ok: true; found: true; stateName: string }
	| DrovrReadFailure

export type OwnerCursor = { occurredAt: string; id: string }

export type RepostOutcome = 'accepted' | 'suppressed' | 'rejected'

/**
 * One birth the guard checks: the owner assignment it belongs to (the
 * marker's key and fields), its journey, and the birth to re-post.
 */
export type OwnerBirthSubject = {
	owner: ContactEventRecord
	journeyId: string
	birth?: DrovrShadowEvent
}

export type OwnerBirthGuardPorts = {
	/** Present only after every feed journey reached EOF. Never fail over on error. */
	birthFeed?: BirthFeedProof
	/**
	 * Skills-course and evergreen owner assignments in [from, to], by
	 * (occurredAt, id).
	 */
	scanOwners(args: {
		from: string
		to: string
		after?: OwnerCursor
		limit: number
	}): Promise<ContactEventRecord[]>
	/** Contacts with an unsubscribe, bounce, or complaint ContactEvent. */
	stoppedContactIds(contactIds: readonly string[]): Promise<ReadonlySet<string>>
	/** Recorded, liftable contact.unsubscribed evidence; no import snapshot. */
	unsubscribedValuePathContactIds(
		contactIds: readonly string[],
	): Promise<ReadonlySet<string>>
	/** Ids of the owner events the guard already re-posted (its marker). */
	repostedOwnerEventIds(
		owners: readonly Pick<ContactEventRecord, 'id' | 'contactId'>[],
	): Promise<ReadonlySet<string>>
	/**
	 * Newsletter births due in [from, to]: completed shadow-newsletter list
	 * intents of newsletter-owned contacts, each with the newsletter owner
	 * assignment and the birth rebuilt from the intent. Paged by the
	 * intents' (completedAt, id). Absent: newsletter births are not checked.
	 */
	scanNewsletterBirths?(args: {
		from: string
		to: string
		after?: OwnerCursor
		limit: number
	}): Promise<{ subjects: OwnerBirthSubject[]; next?: OwnerCursor }>
	/** Read adapters must honor the supplied remaining page timeout. */
	readDelivery(
		contactId: string,
		timeoutMs?: number,
	): Promise<DrovrEmailDeliveryRead>
	readActor(
		contactId: string,
		journeyId: string,
		timeoutMs?: number,
	): Promise<DrovrActorRead>
	/** Wall clock for page deadlines, independent of memoized run start. */
	nowMs?: () => number
	/** One event to drovr; throws on a transient failure (the step retries). */
	post(event: DrovrShadowEvent): Promise<DrovrDeliveryOutcome>
	/** The durable marker: this owner's birth was posted once, with this outcome. */
	recordRepost(owner: ContactEventRecord, outcome: RepostOutcome): Promise<void>
	log: {
		info(event: string, fields: Record<string, unknown>): unknown
		warn(event: string, fields: Record<string, unknown>): unknown
	}
}

type Candidate = {
	owner: ContactEventRecord
	journeyId: string
	birth: DrovrShadowEvent
}

type PageCounts = {
	owners: number
	/** An evergreen or newsletter actor exists: the birth landed. */
	born: number
	skippedSynthetic: number
	skippedStopped: number
	skippedSuppressed: number
	delivered: number
	pending: number
	notRouted: number
	actorWithoutSend: number
	repostNoEffect: number
	unreadable: number
	unmappable: number
}

type PageResult = PageCounts & {
	candidates: Candidate[]
	next?: OwnerCursor
	backpressure?: DrovrReadBackpressure
}

export type OwnerBirthGuardReceipt = PageCounts & {
	status: 'checked' | 'deferred'
	/** Unknown read, not absence; no births are re-posted in this run. */
	backpressure?: DrovrReadBackpressure
	from: string
	to: string
	pages: number
	candidates: number
	reposted: number
	suppressedOnPost: number
	rejectedOnPost: number
	capHit: boolean
	overCap: number
	/** Not every owner in the window was read: MAX_PAGES was reached. */
	truncated: boolean
	/** Candidates per journey, before the cap (the hawk, 09-30). */
	candidatesByJourney: Record<string, number>
	newsletterPages: number
	/** Feed absence is only potential: target actor must confirm it. */
	birthConfirmations?: number
}

const zeroCounts = (): PageCounts => ({
	owners: 0,
	born: 0,
	skippedSynthetic: 0,
	skippedStopped: 0,
	skippedSuppressed: 0,
	delivered: 0,
	pending: 0,
	notRouted: 0,
	actorWithoutSend: 0,
	repostNoEffect: 0,
	unreadable: 0,
	unmappable: 0,
})

async function logSafely(
	write: (event: string, fields: Record<string, unknown>) => unknown,
	event: string,
	fields: Record<string, unknown>,
): Promise<void> {
	try {
		await write(event, fields)
	} catch {
		// Logging cannot change what the guard decided.
	}
}

type Verdict =
	| { kind: 'delivered' | 'pending' | 'notRouted' | 'born' }
	| { kind: 'unreadable'; reason: string }
	| { kind: 'shed'; backpressure: DrovrReadBackpressure }
	| { kind: 'actorWithoutSend'; stateName: string }
	| { kind: 'suppressed'; stateName: string }
	| { kind: 'lost' }

/** Each read is capped by its normal 10s timeout and the page's remaining
 * wall budget. An exhausted budget is unknown, never absence. */
async function pageRead<T extends DrovrActorRead | DrovrEmailDeliveryRead>(
	ports: OwnerBirthGuardPorts,
	deadlineMs: number,
	operation: (timeoutMs: number) => Promise<T>,
): Promise<T | DrovrReadFailure> {
	const now = ports.nowMs ?? Date.now
	const remaining = deadlineMs - now()
	if (!Number.isFinite(remaining) || remaining <= 0)
		return {
			ok: false,
			reason: 'page wall budget exhausted',
			backpressure: { status: 'page-budget' },
		}
	const result = await operation(Math.min(10_000, remaining))
	// Preserve a shed response's Retry-After even at the deadline boundary.
	if (!result.ok && result.backpressure) return result
	if (now() >= deadlineMs)
		return {
			ok: false,
			reason: 'page wall budget exhausted',
			backpressure: { status: 'page-budget' },
		}
	return result
}

async function judge(
	ports: OwnerBirthGuardPorts,
	contactId: string,
	journeyId: string,
	deadlineMs: number,
): Promise<Verdict> {
	if (journeyId !== OWNER_BIRTH_GUARD_JOURNEY_ID) {
		// No lesson one to ask about: the actor snapshot alone says whether
		// the birth landed.
		const actor = await pageRead(ports, deadlineMs, (timeoutMs) =>
			ports.readActor(contactId, journeyId, timeoutMs),
		)
		if (!actor.ok)
			return actor.backpressure
				? { kind: 'shed', backpressure: actor.backpressure }
				: { kind: 'unreadable', reason: `actor: ${actor.reason}` }
		if (actor.found) return { kind: 'born' }
		return judgeLost(ports, contactId, deadlineMs)
	}
	const read = await pageRead(ports, deadlineMs, (timeoutMs) =>
		ports.readDelivery(contactId, timeoutMs),
	)
	if (!read.ok)
		return read.backpressure
			? { kind: 'shed', backpressure: read.backpressure }
			: { kind: 'unreadable', reason: `delivery: ${read.reason}` }
	const status = read.delivery.status
	if (status === 'delivered') return { kind: 'delivered' }
	if (status === 'pending') return { kind: 'pending' }
	if (status === 'not-routed') return { kind: 'notRouted' }
	// not-started: no value-path receipt. Only an absent actor snapshot
	// (404 contact-not-found) proves the birth itself is missing.
	const actor = await pageRead(ports, deadlineMs, (timeoutMs) =>
		ports.readActor(contactId, OWNER_BIRTH_GUARD_JOURNEY_ID, timeoutMs),
	)
	if (!actor.ok)
		return actor.backpressure
			? { kind: 'shed', backpressure: actor.backpressure }
			: { kind: 'unreadable', reason: `actor: ${actor.reason}` }
	if (actor.found)
		return { kind: 'actorWithoutSend', stateName: actor.stateName }
	return judgeLost(ports, contactId, deadlineMs)
}

/** No actor on the journey: lost, unless drovr's directory holds a stop. */
async function judgeLost(
	ports: OwnerBirthGuardPorts,
	contactId: string,
	deadlineMs: number,
): Promise<Verdict> {
	const directory = await pageRead(ports, deadlineMs, (timeoutMs) =>
		ports.readActor(contactId, DIRECTORY_JOURNEY_ID, timeoutMs),
	)
	if (!directory.ok)
		return directory.backpressure
			? { kind: 'shed', backpressure: directory.backpressure }
			: { kind: 'unreadable', reason: `directory: ${directory.reason}` }
	if (directory.found && STOPPED_DIRECTORY_STATE.test(directory.stateName))
		return { kind: 'suppressed', stateName: directory.stateName }
	return { kind: 'lost' }
}

/** An owner assignment's own birth, exactly as the live dispatch maps it. */
function ownerSubject(owner: ContactEventRecord): OwnerBirthSubject {
	const births = mapDrovrShadowFact({ kind: 'contact-event', event: owner })
	const birth = births.find((event) => event.type === 'contact.created')
	return {
		owner,
		journeyId:
			birth?.journeyId ??
			OWNER_BIRTH_GUARD_OWNER_JOURNEY_IDS.find((journeyId) =>
				owner.providerEventId.endsWith(`:${journeyId}`),
			) ??
			OWNER_BIRTH_GUARD_JOURNEY_ID,
		...(birth ? { birth } : {}),
	}
}

async function checkOwnerPage(
	ports: OwnerBirthGuardPorts,
	window: { from: string; to: string },
	after: OwnerCursor | undefined,
	pageSize: number,
): Promise<PageResult> {
	const deadlineMs =
		(ports.nowMs ?? Date.now)() + OWNER_BIRTH_GUARD_PAGE_BUDGET_MS
	const rows = await ports.scanOwners({ ...window, after, limit: pageSize })
	const last = rows.at(-1)
	return checkSubjects(
		ports,
		rows.map(ownerSubject),
		rows.length === pageSize && last
			? { occurredAt: last.occurredAt, id: last.id }
			: undefined,
		deadlineMs,
	)
}

async function checkNewsletterPage(
	ports: OwnerBirthGuardPorts,
	window: { from: string; to: string },
	after: OwnerCursor | undefined,
	pageSize: number,
): Promise<PageResult> {
	const deadlineMs =
		(ports.nowMs ?? Date.now)() + OWNER_BIRTH_GUARD_PAGE_BUDGET_MS
	const page = ports.scanNewsletterBirths
		? await ports.scanNewsletterBirths({ ...window, after, limit: pageSize })
		: { subjects: [] }
	return checkSubjects(ports, page.subjects, page.next, deadlineMs)
}

async function checkSubjects(
	ports: OwnerBirthGuardPorts,
	subjects: readonly OwnerBirthSubject[],
	next: OwnerCursor | undefined,
	deadlineMs: number,
): Promise<PageResult> {
	const counts = zeroCounts()
	counts.owners = subjects.length
	const real = subjects.filter(
		(subject) => !isSyntheticPrincipalId(subject.owner.contactId),
	)
	counts.skippedSynthetic = subjects.length - real.length
	// Required reads, never fail-open: a failure fails the step.
	const stopped = await ports.stoppedContactIds([
		...new Set(real.map((subject) => subject.owner.contactId)),
	])
	const reposted = await ports.repostedOwnerEventIds(
		real.map((subject) => subject.owner),
	)
	const valuePathIds = [
		...new Set(
			real
				.filter((subject) => subject.journeyId.startsWith('value-path-'))
				.map((subject) => subject.owner.contactId),
		),
	]
	const birthOptOuts =
		valuePathIds.length > 0
			? await ports.unsubscribedValuePathContactIds(valuePathIds)
			: new Set<string>()
	const live = real.filter(
		(subject) =>
			!stopped.has(subject.owner.contactId) &&
			!(
				subject.journeyId.startsWith('value-path-') &&
				birthOptOuts.has(subject.owner.contactId)
			),
	)
	counts.skippedStopped = real.length - live.length

	// Serial evaluation stops before starting the next contact on shedding.
	// This is an early-stop fence, not a read-rate limiter.
	const verdicts: { subject: OwnerBirthSubject; verdict: Verdict }[] = []
	const feed = ports.birthFeed ? await ports.birthFeed.judge(live) : undefined
	for (const subject of live) {
		const verdict: Verdict = feed
			? feed.get(subject) === 'born'
				? { kind: 'born' }
				: feed.get(subject) === 'missing'
					? { kind: 'lost' } // potential only; bounded confirmation phase below
					: { kind: 'unreadable', reason: 'birth feed coverage is unknown' }
			: await judge(
					ports,
					subject.owner.contactId,
					subject.journeyId,
					deadlineMs,
				)
		verdicts.push({ subject, verdict })
		if (verdict.kind === 'shed') break
	}
	const candidates: Candidate[] = []
	let backpressure: DrovrReadBackpressure | undefined
	for (const { subject, verdict } of verdicts) {
		const row = subject.owner
		const fields = {
			contactId: row.contactId,
			ownerEventId: row.id,
			journeyId: subject.journeyId,
			occurredAt: row.occurredAt,
		}
		switch (verdict.kind) {
			case 'delivered':
			case 'pending':
			case 'notRouted':
			case 'born':
				counts[verdict.kind] += 1
				break
			case 'shed':
				counts.unreadable += 1
				backpressure = verdict.backpressure
				break
			case 'unreadable':
				counts.unreadable += 1
				await logSafely(ports.log.warn, 'drovr.owner_birth_guard.unreadable', {
					...fields,
					reason: verdict.reason,
				})
				break
			case 'actorWithoutSend':
				counts.actorWithoutSend += 1
				await logSafely(
					ports.log.warn,
					'drovr.owner_birth_guard.actor_without_send',
					{ ...fields, stateName: verdict.stateName },
				)
				break
			case 'suppressed':
				counts.skippedSuppressed += 1
				await logSafely(ports.log.info, 'drovr.owner_birth_guard.suppressed', {
					...fields,
					stateName: verdict.stateName,
				})
				break
			case 'lost': {
				if (reposted.has(row.id)) {
					counts.repostNoEffect += 1
					await logSafely(
						ports.log.warn,
						'drovr.owner_birth_guard.repost_no_effect',
						fields,
					)
					break
				}
				const birth =
					subject.birth?.journeyId === subject.journeyId
						? subject.birth
						: undefined
				if (!birth) {
					counts.unmappable += 1
					break
				}
				await logSafely(
					ports.log.warn,
					ports.birthFeed
						? 'drovr.owner_birth_guard.feed_candidate'
						: 'drovr.owner_without_birth',
					{
						...fields,
						idempotencyKey: birth.idempotencyKey,
					},
				)
				candidates.push({ owner: row, journeyId: subject.journeyId, birth })
				break
			}
		}
	}
	return {
		...counts,
		candidates,
		...(next ? { next } : {}),
		...(backpressure ? { backpressure } : {}),
	}
}

/**
 * By the problem's code or type only (the hawk, 201g-f2): a regex over the
 * whole problem also read its title, detail and hint, which are served
 * text, so a wording change could flip a refusal's label.
 */
function repostOutcomeOf(outcome: DrovrDeliveryOutcome): RepostOutcome {
	if (outcome.status === 'accepted') return 'accepted'
	return outcome.status === 'rejected' &&
		drovrProblemCodes(outcome.problem).includes(DROVR_CONTACT_SUPPRESSED)
		? 'suppressed'
		: 'rejected'
}

type GuardStep = {
	run<T>(id: string, operation: () => Promise<T>): Promise<unknown>
}

/**
 * One guard run as Inngest steps: each page (reads and their logs) is one
 * memoized step, each re-post one step keyed by its owner event, then the
 * summary. A replay neither re-reads nor re-posts nor re-logs.
 */
export async function runOwnerBirthGuard(args: {
	step: GuardStep
	ports: OwnerBirthGuardPorts
	/** From a memoized step, so every replay reads the same window. */
	startedAtMs: number
	pageSize?: number
	cap?: number
	maxPages?: number
}): Promise<OwnerBirthGuardReceipt> {
	const { step, ports } = args
	const pageSize = args.pageSize ?? 50
	const cap = args.cap ?? OWNER_BIRTH_GUARD_REPOST_CAP
	const maxPages = args.maxPages ?? MAX_PAGES
	const window = {
		from: new Date(
			args.startedAtMs - OWNER_BIRTH_GUARD_MAX_AGE_MS,
		).toISOString(),
		to: new Date(args.startedAtMs - OWNER_BIRTH_GUARD_MIN_AGE_MS).toISOString(),
	}
	const counts = zeroCounts()
	const candidates: Candidate[] = []
	let after: OwnerCursor | undefined
	let pages = 0
	let truncated = false
	let backpressure: DrovrReadBackpressure | undefined
	for (;;) {
		if (pages === maxPages) {
			truncated = true
			break
		}
		const from = after
		const page = (await step.run(
			`${ports.birthFeed ? 'feed-' : ''}page-${pages}`,
			() => checkOwnerPage(ports, window, from, pageSize),
		)) as PageResult
		pages += 1
		for (const key of Object.keys(counts) as (keyof PageCounts)[])
			counts[key] += page[key] ?? 0
		candidates.push(...page.candidates)
		if (page.backpressure) {
			backpressure = page.backpressure
			truncated = true
			break
		}
		if (!page.next) break
		after = page.next
	}
	// Newsletter births, by their list intents: their own pages and steps.
	let newsletterPages = 0
	let newsletterAfter: OwnerCursor | undefined
	while (!backpressure && ports.scanNewsletterBirths) {
		if (newsletterPages === maxPages) {
			truncated = true
			break
		}
		const from = newsletterAfter
		const page = (await step.run(
			`${ports.birthFeed ? 'feed-' : ''}newsletter-page-${newsletterPages}`,
			() => checkNewsletterPage(ports, window, from, pageSize),
		)) as PageResult
		newsletterPages += 1
		for (const key of Object.keys(counts) as (keyof PageCounts)[])
			counts[key] += page[key] ?? 0
		candidates.push(...page.candidates)
		if (page.backpressure) {
			backpressure = page.backpressure
			truncated = true
			break
		}
		if (!page.next) break
		newsletterAfter = page.next
	}
	const candidatesByJourney: Record<string, number> = {}
	for (const candidate of candidates)
		candidatesByJourney[candidate.journeyId] =
			(candidatesByJourney[candidate.journeyId] ?? 0) + 1

	let birthConfirmations = 0
	let eligible = candidates.slice(0, backpressure ? 0 : cap)
	const birthFeed = ports.birthFeed
	if (birthFeed && !backpressure) {
		eligible = []
		for (const candidate of candidates.slice(
			0,
			Math.min(cap, OWNER_BIRTH_GUARD_CONFIRMATION_CAP),
		)) {
			// SAFETY: this step produces a plain, typed Verdict. Reserve inside
			// the callback so lost SDK results cannot exceed 25 physical reads.
			const verdict = (await step.run(
				`feed-confirm-${candidate.owner.id}`,
				async () => {
					await birthFeed.reserveConfirmation()
					const deadline =
						(ports.nowMs ?? Date.now)() + OWNER_BIRTH_GUARD_PAGE_BUDGET_MS
					const actor = await pageRead(ports, deadline, (timeoutMs) =>
						ports.readActor(
							candidate.owner.contactId,
							candidate.journeyId,
							timeoutMs,
						),
					)
					if (!actor.ok)
						return actor.backpressure
							? { kind: 'shed' as const, backpressure: actor.backpressure }
							: {
									kind: 'unreadable' as const,
									reason: 'birth confirmation unavailable',
								}
					if (actor.found) {
						await birthFeed.observeBorn(
							candidate.journeyId,
							candidate.owner.contactId,
						)
						return { kind: 'born' as const }
					}
					return judgeLost(ports, candidate.owner.contactId, deadline)
				},
			)) as Verdict
			birthConfirmations += 1
			if (verdict.kind === 'shed') {
				backpressure = verdict.backpressure
				truncated = true
				break
			}
			if (verdict.kind === 'lost') eligible.push(candidate)
			else if (verdict.kind === 'born') counts.born += 1
			else if (verdict.kind === 'suppressed') counts.skippedSuppressed += 1
			else counts.unreadable += 1
		}
	}
	const outcomes: RepostOutcome[] = []
	for (const { owner, birth } of backpressure ? [] : eligible) {
		outcomes.push(
			(await step.run(`repost-${owner.id}`, async () => {
				const outcome = repostOutcomeOf(await ports.post(birth))
				await ports.recordRepost(owner, outcome)
				return outcome
			})) as RepostOutcome,
		)
	}
	const overCap = Math.max(0, candidates.length - cap)
	const receipt: OwnerBirthGuardReceipt = {
		status: backpressure ? 'deferred' : 'checked',
		...(backpressure ? { backpressure } : {}),
		...window,
		pages,
		...counts,
		candidates: candidates.length,
		reposted: outcomes.filter((outcome) => outcome === 'accepted').length,
		suppressedOnPost: outcomes.filter((outcome) => outcome === 'suppressed')
			.length,
		rejectedOnPost: outcomes.filter((outcome) => outcome === 'rejected').length,
		capHit: overCap > 0,
		overCap,
		truncated,
		candidatesByJourney,
		newsletterPages,
		...(ports.birthFeed ? { birthConfirmations } : {}),
	}
	await step.run('summary', async () => {
		// Each run rescans the whole window oldest-first, so what a cap or a
		// page limit leaves is read again next hour, before it ages out, as
		// long as fewer than cap (or maxPages x pageSize) arrive an hour.
		if (receipt.truncated)
			await logSafely(ports.log.warn, 'drovr.owner_birth_guard.truncated', {
				pages,
				pageSize,
				owners: receipt.owners,
			})
		if (receipt.capHit)
			await logSafely(ports.log.warn, 'drovr.owner_birth_guard.cap_hit', {
				cap,
				candidates: receipt.candidates,
				candidatesByJourney,
				overCap,
			})
		if (backpressure)
			await logSafely(ports.log.warn, 'drovr.owner_birth_guard.read_shed', {
				status: backpressure.status,
				pages,
				newsletterPages,
				candidatesDeferred: candidates.length,
			})
		// Do not log arbitrary provider header text.
		await logSafely(ports.log.info, 'drovr.owner_birth_guard.summary', {
			...receipt,
			...(backpressure
				? { backpressure: { status: backpressure.status } }
				: {}),
		})
		return true
	})
	return receipt
}
