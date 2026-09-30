import { db } from '@/db'
import {
	contact,
	contactEvent,
	providerIdentity,
	sideEffectIntent,
} from '@/db/schema'
import { AI_HERO_SKILLS_EXCLUSION_TAG_IDS } from '@/lib/kit-broadcasts'
import {
	activeContactStopsByKey,
	CONTACT_STOP_RULE_EVENT_TYPES,
	isContactStopped,
	stopSignalOfEvent,
	type ContactStopSignal,
} from '@/lib/subscriber-marketing/contact-stop-rule'
import { UNSUBSCRIBE_KIT_LIST_INTENT_TYPE } from '@/lib/subscriber-marketing/drovr-list-unsubscribe'
import { JOURNEY_OWNER_ASSIGNED_EVENT_TYPE } from '@/lib/subscriber-marketing/drovr-ownership'
import { DROVR_SKILLS_COURSE_JOURNEY_ID } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	addKitReadStats,
	createdDaySlices,
	createKitReader,
	fetchKitMemberIdsInSlices,
	fetchKitSubscriberTagIds,
	KitReadUnavailableError,
	type KitReader,
	type KitReaderOptions,
	type KitReadStats,
} from '@/lib/subscriber-marketing/signup-confirmation-kit-reader'
import {
	buildSignupGapPreview,
	normalizeSignupGapEmail,
	replayableNewestFirst,
	signupConfirmationEvent,
	type SignupConfirmationReconciliationPlan,
	type SignupGapKitSubscriber,
	type SignupGapKitSubscriberState,
} from '@/lib/subscriber-marketing/signup-gap-recovery'
import { SKILLS_WORKFLOW_VALUE_PATH } from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import { AIH_COURSE_COMPLETED_AT_FIELD } from '@/lib/subscriber-marketing/value-path-finisher-capture'
import { emailEquivalenceKey } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { SKILLS_WORKFLOW_EMAIL_STEPS } from '@/lib/subscriber-marketing/skills-workflow-path'
import { and, eq, inArray, or, sql } from 'drizzle-orm'

export const SKILLS_NEWSLETTER_FORM_ID = 9376133
/**
 * The floor: only subscribers who joined the form at or after this instant
 * are ever replayed. Kit has no confirmation time, so a signup from before
 * it that confirms later is not either. Joel's call (2026-09-25): the
 * backlog stranded before this fix is let go, not enrolled.
 */
export const SKILLS_CONFIRMATION_RECONCILIATION_START =
	'2026-09-25T00:00:00.000Z'
/**
 * Every replayed confirmation of a new signup is a birth in drovr, so each
 * run (four an hour) stays small and a backlog drains over a few runs: at
 * most 200 births an hour.
 */
export const SKILLS_CONFIRMATION_RECONCILIATION_LIMIT = 50

/**
 * The stop lever: AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT can pause
 * (0) or slow the reconciler, never raise it past the default. Anything
 * unparseable falls back to the default.
 */
export function skillsConfirmationReconciliationLimit(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const raw = env.AIH_SKILLS_CONFIRMATION_RECONCILIATION_LIMIT?.trim()
	if (!raw || !/^\d+$/.test(raw))
		return SKILLS_CONFIRMATION_RECONCILIATION_LIMIT
	return Math.min(Number(raw), SKILLS_CONFIRMATION_RECONCILIATION_LIMIT)
}

/**
 * Opt-out evidence recorded locally: Kit webhooks and drovr list
 * unsubscribes. The shared rule decides which is still active: a fresh
 * double opt-in lifts an unsubscribe (contact-stop-rule).
 */
const OPT_OUT_EVENT_TYPES: string[] = [...CONTACT_STOP_RULE_EVENT_TYPES]

type OptOutEvidenceRow<Key> = {
	key: Key | null
	contactId: string
	eventType: string
	occurredAt: Date
}
type OptOutIntentRow<Key> = {
	key: Key | null
	contactId: string
	type: string
	createdAt: Date
}

/**
 * The keys (an email or a Kit id) with at least one contact whose stop is
 * still active. A drovr list.unsubscribe row counts as an unsubscribe at
 * the row's creation (drovr's intent arrived then).
 */
function stoppedKeys<Key>(
	events: OptOutEvidenceRow<Key>[],
	intents: OptOutIntentRow<Key>[],
): Set<Key> {
	const keysByContact = new Map<string, Set<Key>>()
	const signals: { key: string; signal: ContactStopSignal | undefined }[] = []
	const note = (contactId: string, key: Key | null) => {
		if (key === null) return
		const keys = keysByContact.get(contactId) ?? new Set<Key>()
		keys.add(key)
		keysByContact.set(contactId, keys)
	}
	for (const row of events) {
		note(row.contactId, row.key)
		signals.push({ key: row.contactId, signal: stopSignalOfEvent(row) })
	}
	for (const row of intents) {
		if (row.type !== UNSUBSCRIBE_KIT_LIST_INTENT_TYPE) continue
		note(row.contactId, row.key)
		signals.push({
			key: row.contactId,
			signal: {
				kind: 'unsubscribed',
				at: row.createdAt.toISOString(),
			},
		})
	}
	const stopped = new Set<Key>()
	for (const [contactId, active] of activeContactStopsByKey(signals)) {
		if (!isContactStopped(active)) continue
		for (const key of keysByContact.get(contactId) ?? []) stopped.add(key)
	}
	return stopped
}

/** A legacy or drovr send of any course email; each ran through the executor. */
const SEND_VALUE_PATH_EMAIL_INTENT_TYPE = 'send-value-path-email'

/**
 * Email 0 of the individual and team skills paths. Every course send is a
 * per-email Kit sequence subscription and email 0 comes first, so anyone
 * who got any course email is in one of these.
 */
export const SKILLS_EMAIL_ZERO_KIT_SEQUENCE_IDS =
	SKILLS_WORKFLOW_EMAIL_STEPS.filter((step) =>
		step.emailResourceId.endsWith('-0'),
	).map((step) => step.kitSequenceId)

const KIT_SUBSCRIBER_STATES = [
	'active',
	'inactive',
	'cancelled',
	'bounced',
	'complained',
] as const satisfies readonly SignupGapKitSubscriberState[]

type KitFormSubscriberRecord = SignupGapKitSubscriber & {
	addedAt: string
}

type ReconcilerDatabase = Pick<typeof db, 'select'>

/**
 * The scan's two tiers (row 211, the hawk): the last 14 days of form
 * signups on every 15-minute poll, and every signup since the floor once a
 * day. Nobody is dropped: a learner who confirms on day 20 is entered by
 * the next daily run, just later.
 */
export type SkillsConfirmationTier = 'recent' | 'daily'
export const SKILLS_CONFIRMATION_RECENT_TIER_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export function skillsConfirmationTierWindow(
	tier: SkillsConfirmationTier,
	to: string,
): { from: string; to: string } {
	const floor = Date.parse(SKILLS_CONFIRMATION_RECONCILIATION_START)
	const toMs = Date.parse(to)
	const from =
		tier === 'daily'
			? floor
			: Math.max(floor, toMs - SKILLS_CONFIRMATION_RECENT_TIER_DAYS * DAY_MS)
	return {
		from: new Date(from).toISOString(),
		to: new Date(toMs).toISOString(),
	}
}

export type SkillsConfirmationEvent =
	SignupConfirmationReconciliationPlan['events'][number]

/**
 * What the scan found: the confirmed, unentered subscribers with no local
 * opt-out and no course history, newest signups first. Each still needs
 * its fresh Kit tag check before it is sent.
 */
export type SkillsConfirmationScan = {
	tier: SkillsConfirmationTier
	generatedAt: string
	formId: number
	window: { from: string; to: string }
	limit: number
	counts: {
		kitFormSubscribersFetched: number
		inWindow: number
		unconfirmed: number
		withExistingCourseEntry: number
		excludedSynthetic: number
		excludedOptedOut: number
		/** Of them, by an AI Hero or AI Skills unsubscribe tag in Kit. */
		excludedByTag: number
		/** Left for the next run: they'd have needed a 21st email 0 slice. */
		deferredBySliceLimit: number
		excludedCourseHistory: number
		candidates: number
	}
	events: SkillsConfirmationEvent[]
	/** How the opt-out tags were read: in slices, whole, or not at all. */
	tagRead: 'none' | 'sliced' | 'whole'
	kit: KitReadStats
}

/**
 * Up to this many creation-day slices, the opt-out tags are read in slices
 * (2 requests each); past it, whole (about 14 pages today, measured
 * 2026-09-30: 11,608 and 1,482 members).
 */
export const SKILLS_CONFIRMATION_TAG_SLICE_LIMIT = 7
/** At most this many email 0 slices a run (2 requests each, and paging). */
export const SKILLS_CONFIRMATION_EMAIL_ZERO_SLICE_LIMIT = 20

/**
 * The candidates that fit in `limit` creation-day slices, and how many are
 * left beyond them, in the candidates' own order. A candidate created on
 * the same UTC day as one already in always fits (the same padded window).
 * A candidate that doesn't fit is passed over, not a stop: a later one on
 * a day already in still fits.
 *
 * Without `rotateBy`, candidates are taken in order, newest signup first:
 * the recent tier, so a fresh confirmer always takes the first slice
 * (Sonnet 2, #348: rotating there starved fresh confirmers).
 *
 * With `rotateBy` (the daily tier's run index), when they don't all fit,
 * the start moves on by `limit` places a run. Standing candidates (an
 * email 0 member Kit alone knows about, a 404, a failing tag check) then
 * can't hold the same slices day after day (the hawk, #348). For a stable
 * set, everyone is in within ⌈n / limit⌉ daily runs: adding a candidate
 * adds at most one slice, so the next `limit` in line always fit.
 */
export function withinSliceLimit<T extends { createdAt: string }>(
	candidates: readonly T[],
	limit: number,
	rotateBy?: number,
): { within: T[]; beyond: number } {
	const all = candidates.map((candidate) => candidate.createdAt)
	if (createdDaySlices(all).length <= limit)
		return { within: [...candidates], beyond: 0 }
	const n = candidates.length
	const offset = rotateBy === undefined ? 0 : (((rotateBy * limit) % n) + n) % n
	const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)]
	const chosen = new Set<T>()
	const days: string[] = []
	for (const candidate of rotated) {
		if (createdDaySlices([...days, candidate.createdAt]).length > limit)
			continue
		chosen.add(candidate)
		days.push(candidate.createdAt)
	}
	return {
		within: candidates.filter((candidate) => chosen.has(candidate)),
		beyond: candidates.length - chosen.size,
	}
}

/**
 * The daily tier's run index: one step a day. A daily run queued late
 * behind a poll keeps its day's index.
 */
export function skillsConfirmationDailyRunIndex(to: string): number {
	return Math.floor(Date.parse(to) / DAY_MS)
}

/**
 * Scan one tier (row 211). Cheapest first: the form's subscribers, then
 * local evidence (entries, opt-outs, course sends) and the completion
 * field. Only if someone is left does it read Kit's email 0 sequences, and
 * then only for the days those subscribers' Kit records were created
 * (`createdDaySlices`), in parallel slices under the reader's limits. The
 * two opt-out tags are read first (in slices, or whole past a few), and a
 * tagged candidate never reaches email 0's slices or the checks. Each
 * remaining candidate's tags are read once more, fresh, just before its
 * send (`checkSkillsConfirmationTags`).
 */
export async function scanSkillsConfirmations(args: {
	tier: SkillsConfirmationTier
	to?: string
	limit?: number
	database?: ReconcilerDatabase
	kit?: KitReaderOptions
}): Promise<SkillsConfirmationScan> {
	const to = new Date(args.to ?? new Date().toISOString()).toISOString()
	const window = skillsConfirmationTierWindow(args.tier, to)
	const reader = createKitReader(kitApiKey(), args.kit)
	try {
		const subscribers = await fetchKitFormSubscribersForStates(reader, {
			formId: SKILLS_NEWSLETTER_FORM_ID,
			addedAfter: window.from,
			states: KIT_SUBSCRIBER_STATES,
		})
		const identityMatches = await fetchIdentityMatches(
			subscribers,
			args.database ?? db,
		)
		const courseCompleted = subscribers
			.filter((subscriber) => {
				const value = subscriber.fields?.[AIH_COURSE_COMPLETED_AT_FIELD]
				return value != null && String(value).trim() !== ''
			})
			.map((subscriber) => subscriber.kitSubscriberId)
		const preview = buildSignupGapPreview({
			subscribers,
			identityMatches: {
				...identityMatches,
				courseHistoryKitSubscriberIds: new Set([
					...identityMatches.courseHistoryKitSubscriberIds,
					...courseCompleted,
				]),
			},
			formId: SKILLS_NEWSLETTER_FORM_ID,
			from: window.from,
			to,
			now: to,
		})
		let candidates = replayableNewestFirst(preview.candidates)
		let inEmailZero = 0
		let taggedOptOut = 0
		let deferredBySliceLimit = 0
		let tagRead: 'none' | 'sliced' | 'whole' = 'none'
		// Most polls end here: nobody new, so no Kit list is read at all.
		if (candidates.length > 0) {
			// 1. The opt-out tags. A Kit-tag opt-out is never recorded locally,
			// so it stays a candidate every poll: it's excluded here, before the
			// check loop and before email 0's slices, so it costs neither
			// (Sonnet 2, #348 rounds 2 and 3). Sliced while the candidates fit
			// in a few creation-day slices; past that, the two lists whole, so
			// piled-up opt-outs cost at most their 14 or so pages.
			const tagSlices = createdDaySlices(
				candidates.map((candidate) => candidate.createdAt),
			)
			tagRead =
				tagSlices.length <= SKILLS_CONFIRMATION_TAG_SLICE_LIMIT
					? 'sliced'
					: 'whole'
			const tagged = await fetchKitMemberIdsInSlices(
				reader,
				AI_HERO_SKILLS_EXCLUSION_TAG_IDS.map((id) => `tags/${id}`),
				tagRead === 'sliced' ? tagSlices : ['whole'],
			)
			const consenting = candidates.filter(
				(candidate) => !tagged.has(candidate.kitSubscriberId),
			)
			taggedOptOut = candidates.length - consenting.length
			// 2. Email 0, over the rest only, in at most 20 slices. Anyone who'd
			// need a 21st waits a run: newest first on the recent tier, and a
			// start that moves on day by day on the daily tier.
			const { within, beyond } = withinSliceLimit(
				consenting,
				SKILLS_CONFIRMATION_EMAIL_ZERO_SLICE_LIMIT,
				args.tier === 'daily' ? skillsConfirmationDailyRunIndex(to) : undefined,
			)
			deferredBySliceLimit = beyond
			const members =
				within.length > 0
					? await fetchKitMemberIdsInSlices(
							reader,
							SKILLS_EMAIL_ZERO_KIT_SEQUENCE_IDS.map((id) => `sequences/${id}`),
							createdDaySlices(within.map((candidate) => candidate.createdAt)),
						)
					: new Set<string>()
			candidates = within.filter(
				(candidate) => !members.has(candidate.kitSubscriberId),
			)
			inEmailZero = within.length - candidates.length
		}
		await reader.settle()
		return {
			tier: args.tier,
			generatedAt: preview.generatedAt,
			formId: SKILLS_NEWSLETTER_FORM_ID,
			window,
			limit: args.limit ?? skillsConfirmationReconciliationLimit(),
			counts: {
				kitFormSubscribersFetched: preview.counts.kitFormSubscribersFetched,
				inWindow: preview.counts.inWindow,
				unconfirmed: preview.counts.unconfirmed,
				withExistingCourseEntry: preview.counts.withExistingCourseEntry,
				excludedSynthetic: preview.counts.excludedSynthetic,
				excludedOptedOut: preview.counts.excludedOptedOut + taggedOptOut,
				excludedByTag: taggedOptOut,
				deferredBySliceLimit,
				excludedCourseHistory:
					preview.counts.excludedCourseHistory + inEmailZero,
				candidates: candidates.length,
			},
			tagRead,
			events: candidates.map((candidate) =>
				signupConfirmationEvent({
					candidate,
					formId: SKILLS_NEWSLETTER_FORM_ID,
				}),
			),
			kit: reader.stats(),
		}
	} catch (error) {
		throw asEvidenceError(error)
	}
}

/**
 * The fresh opt-out check for one candidate, just before its send: its own
 * Kit tags (`GET /v4/subscribers/{id}/tags`), against the AI Hero and AI
 * Skills unsubscribe tags. Nothing is sent without that evidence:
 * - a subscriber Kit no longer has (404) is `not-in-kit`;
 * - any other failure for this subscriber (a 4xx, a malformed or endless
 *   page, a 5xx or no answer after the retries) is `tag-check-failed`: this
 *   one is skipped and checked again next poll, so one bad record never
 *   holds back the older confirmers behind it (Sonnet 2, #348);
 * - Kit still throttling the key (429 after the backoff) throws: that is
 *   not about this subscriber, and the run stops.
 */
export async function checkSkillsConfirmationTags(args: {
	kitSubscriberId: string
	kit?: KitReaderOptions
}): Promise<{
	verdict: 'consenting' | 'opted-out' | 'not-in-kit' | 'tag-check-failed'
	reason?: string
	kit: KitReadStats
}> {
	const reader = createKitReader(kitApiKey(), args.kit)
	try {
		const tagIds = await fetchKitSubscriberTagIds(reader, args.kitSubscriberId)
		await reader.settle()
		const verdict =
			tagIds === 'not-found'
				? 'not-in-kit'
				: AI_HERO_SKILLS_EXCLUSION_TAG_IDS.some((tagId) =>
							tagIds.has(String(tagId)),
					  )
					? 'opted-out'
					: 'consenting'
		return { verdict, kit: reader.stats() }
	} catch (error) {
		if (error instanceof KitReadUnavailableError && error.statusCode !== 429) {
			await reader.settle()
			return {
				verdict: 'tag-check-failed',
				reason: error.reason,
				kit: reader.stats(),
			}
		}
		throw asEvidenceError(error)
	}
}

/**
 * At most this many tag checks a run (each is a step and a Kit request),
 * so candidates skipped every run (a Kit-tag opt-out is never recorded
 * locally) can't push a run past its slot or Inngest's step cap. The rest
 * are deferred to the next run.
 */
export const SKILLS_CONFIRMATION_TAG_CHECKS_PER_RUN = 100
/**
 * This many tag checks failing in a row means Kit, not the subscribers:
 * the run stops, closed, instead of trying everyone.
 */
export const SKILLS_CONFIRMATION_TAG_FAILURES_IN_A_ROW = 3

/** How a run steps: Inngest's `step.run` and `step.sendEvent`, or direct. */
export type SkillsConfirmationSteps = {
	run: <T>(id: string, work: () => Promise<T>) => Promise<T>
	send: (id: string, event: SkillsConfirmationEvent) => Promise<unknown>
}

export type SkillsConfirmationReceipt = {
	mode: 'signup-confirmation-reconciliation'
	tier: SkillsConfirmationTier
	generatedAt: string
	formId: number
	window: { from: string; to: string }
	limit: number
	counts: SkillsConfirmationScan['counts'] & {
		/** Candidates whose tags were read this run. */
		tagChecked: number
		/**
		 * Every Kit-tag opt-out of the run: at the scan (`excludedByTag`)
		 * plus at the fresh check (`excludedByFreshTagCheck`).
		 */
		excludedByTagTotal: number
		/** Tagged since the scan: caught by the fresh check before the send. */
		excludedByFreshTagCheck: number
		/** Of them, gone from Kit (404). */
		notInKit: number
		/** Of them, whose tags Kit would not give: skipped, checked again next poll. */
		tagFailed: number
		/** Sent this run, each as soon as its tags cleared. */
		planned: number
		/**
		 * Left for the next run, every cause: `deferredBySendLimit` +
		 * `deferredByCheckCap` + `deferredBySliceLimit` + `tagFailed`.
		 */
		deferred: number
		/** Left because the run already sent its limit. */
		deferredBySendLimit: number
		/** Left because the run already checked 100. */
		deferredByCheckCap: number
		/** Sent, and joined the form before the recent tier's window: the daily tier's catch. */
		plannedOlderThanRecentTier: number
	}
	/** How the opt-out tags were read this run. */
	tagRead: SkillsConfirmationScan['tagRead']
	/** Every Kit request of the run, retries included, and the 429s among them. */
	kit: KitReadStats
}

/**
 * One reconciler run (row 211): scan the tier, then for each candidate,
 * newest first, check its tags and send its event at once, in its own
 * steps. A rerun or an overlapping tier sends the same event ids
 * (`skills-confirmed:<form>:<subscriber>`), which Inngest drops.
 */
export async function reconcileSkillsConfirmations(args: {
	tier: SkillsConfirmationTier
	steps: SkillsConfirmationSteps
	to?: string
	limit?: number
	database?: ReconcilerDatabase
	kit?: KitReaderOptions
	onSent?: (event: SkillsConfirmationEvent) => void
	onTagCheckFailed?: (failure: {
		kitSubscriberId: string
		reason: string
	}) => void
}): Promise<SkillsConfirmationReceipt> {
	const scan = await args.steps.run('scan-confirmation-candidates', () =>
		scanSkillsConfirmations(args),
	)
	let kit = scan.kit
	let tagChecked = 0
	let excludedByFreshTagCheck = 0
	let notInKit = 0
	let tagFailed = 0
	let failedInARow = 0
	let planned = 0
	let plannedOlderThanRecentTier = 0
	const recentFrom = Date.parse(
		skillsConfirmationTierWindow('recent', scan.window.to).from,
	)
	let stoppedBy: 'send-limit' | 'check-cap' | undefined
	for (const event of scan.events) {
		// The limit counts sends; the cap counts checks.
		if (planned >= scan.limit) {
			stoppedBy = 'send-limit'
			break
		}
		if (tagChecked >= SKILLS_CONFIRMATION_TAG_CHECKS_PER_RUN) {
			stoppedBy = 'check-cap'
			break
		}
		const { kitSubscriberId } = event.data
		const checked = await args.steps.run(
			`check-opt-out-tags:${kitSubscriberId}`,
			() => checkSkillsConfirmationTags({ kitSubscriberId, kit: args.kit }),
		)
		tagChecked += 1
		kit = addKitReadStats(kit, checked.kit)
		if (checked.verdict === 'tag-check-failed') {
			tagFailed += 1
			failedInARow += 1
			args.onTagCheckFailed?.({
				kitSubscriberId,
				reason: checked.reason ?? 'unknown',
			})
			if (failedInARow >= SKILLS_CONFIRMATION_TAG_FAILURES_IN_A_ROW)
				throw new ReconcilerEvidenceUnavailableError(
					'subscriber tags',
					`${failedInARow} tag checks failed in a row`,
				)
			continue
		}
		failedInARow = 0
		if (checked.verdict === 'opted-out') {
			excludedByFreshTagCheck += 1
			continue
		}
		if (checked.verdict === 'not-in-kit') {
			notInKit += 1
			continue
		}
		await args.steps.send(
			`enqueue-confirmed-subscriber:${kitSubscriberId}`,
			event,
		)
		planned += 1
		if (Date.parse(event.data.subscribedAt ?? '') < recentFrom)
			plannedOlderThanRecentTier += 1
		args.onSent?.(event)
	}
	const unchecked = scan.events.length - tagChecked
	return {
		mode: 'signup-confirmation-reconciliation',
		tier: scan.tier,
		generatedAt: scan.generatedAt,
		formId: scan.formId,
		window: scan.window,
		limit: scan.limit,
		tagRead: scan.tagRead,
		counts: {
			...scan.counts,
			excludedOptedOut: scan.counts.excludedOptedOut + excludedByFreshTagCheck,
			excludedByTagTotal: scan.counts.excludedByTag + excludedByFreshTagCheck,
			tagChecked,
			excludedByFreshTagCheck,
			notInKit,
			tagFailed,
			planned,
			deferred: unchecked + scan.counts.deferredBySliceLimit + tagFailed,
			deferredBySendLimit: stoppedBy === 'send-limit' ? unchecked : 0,
			deferredByCheckCap: stoppedBy === 'check-cap' ? unchecked : 0,
			plannedOlderThanRecentTier,
		},
		kit,
	}
}

function asEvidenceError(error: unknown) {
	return error instanceof KitReadUnavailableError
		? new ReconcilerEvidenceUnavailableError(error.resource, error.reason)
		: error
}

async function fetchIdentityMatches(
	subscribers: SignupGapKitSubscriber[],
	database: ReconcilerDatabase,
) {
	const emails = Array.from(
		new Set(
			subscribers
				.map((subscriber) => normalizeSignupGapEmail(subscriber.email))
				.filter((email): email is string => Boolean(email)),
		),
	)
	const subscriberIds = Array.from(
		new Set(subscribers.map((subscriber) => subscriber.kitSubscriberId)),
	)
	const contactEmails = new Set<string>()
	const matchedSubscriberIds = new Set<string>()
	const courseEntryKitSubscriberIds = new Set<string>()
	const optedOutKitSubscriberIds = new Set<string>()
	const optedOutEmails = new Set<string>()
	const courseHistoryKitSubscriberIds = new Set<string>()
	const courseHistoryEmails = new Set<string>()

	// Address evidence goes through the canonical email key. A stale key
	// anywhere means an equivalent address could hide behind a raw spelling,
	// so the run fails instead of entering anyone on partial evidence.
	const [stale] = await database
		.select({ id: contact.id })
		.from(contact)
		.where(eq(contact.emailKeyStale, 1))
		.limit(1)
	if (stale) {
		throw new ReconcilerEvidenceUnavailableError(
			'contact-email-key',
			'a Contact email key is stale',
		)
	}
	const emailByKey = new Map(
		emails.map((email) => [emailEquivalenceKey(email), email]),
	)
	for (const keyChunk of chunk(Array.from(emailByKey.keys()), 500)) {
		const rows = await database
			.select({ emailKey: contact.emailKey })
			.from(contact)
			.where(inArray(contact.emailKey, keyChunk))
		for (const row of rows) {
			const email = row.emailKey ? emailByKey.get(row.emailKey) : undefined
			if (email) contactEmails.add(email)
		}
		// A contact Kit knows under another subscriber id still carries its
		// opt-out and its course history by address.
		const optOutEventRows = await database
			.select({
				emailKey: contact.emailKey,
				contactId: contact.id,
				eventType: contactEvent.eventType,
				occurredAt: contactEvent.occurredAt,
			})
			.from(contact)
			.innerJoin(contactEvent, eq(contactEvent.contactId, contact.id))
			.where(
				and(
					inArray(contact.emailKey, keyChunk),
					inArray(contactEvent.eventType, OPT_OUT_EVENT_TYPES),
				),
			)
		const intentRows = await database
			.select({
				emailKey: contact.emailKey,
				contactId: contact.id,
				type: sideEffectIntent.type,
				createdAt: sideEffectIntent.createdAt,
			})
			.from(contact)
			.innerJoin(sideEffectIntent, eq(sideEffectIntent.contactId, contact.id))
			.where(
				and(
					inArray(contact.emailKey, keyChunk),
					inArray(sideEffectIntent.type, [
						UNSUBSCRIBE_KIT_LIST_INTENT_TYPE,
						SEND_VALUE_PATH_EMAIL_INTENT_TYPE,
					]),
				),
			)
		const emailOf = (row: { emailKey: string | null }) =>
			(row.emailKey ? emailByKey.get(row.emailKey) : undefined) ?? null
		for (const email of stoppedKeys(
			optOutEventRows.map((row) => ({ ...row, key: emailOf(row) })),
			intentRows.map((row) => ({ ...row, key: emailOf(row) })),
		))
			optedOutEmails.add(email)
		for (const row of intentRows) {
			const email = emailOf(row)
			if (email && row.type !== UNSUBSCRIBE_KIT_LIST_INTENT_TYPE)
				courseHistoryEmails.add(email)
		}
	}
	for (const idChunk of chunk(subscriberIds, 500)) {
		const identityRows = await database
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
				),
			)
		for (const row of identityRows) matchedSubscriberIds.add(row.externalId)

		// Entered means either planner started the course: the legacy entry
		// event, or the contact's own drovr ownership assignment for the skills
		// course (drovr-owned contacts never get a legacy entry event).
		const entryRows = await database
			.select({ externalId: providerIdentity.externalId })
			.from(providerIdentity)
			.innerJoin(
				contactEvent,
				eq(contactEvent.contactId, providerIdentity.contactId),
			)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
					or(
						and(
							eq(contactEvent.eventType, 'value-path.entered'),
							eq(
								contactEvent.providerReference,
								`value-path:${SKILLS_WORKFLOW_VALUE_PATH}`,
							),
						),
						and(
							eq(contactEvent.eventType, JOURNEY_OWNER_ASSIGNED_EVENT_TYPE),
							eq(
								contactEvent.providerEventId,
								sql`concat('drovr-owner:', ${providerIdentity.contactId}, ${`:${DROVR_SKILLS_COURSE_JOURNEY_ID}`})`,
							),
						),
					),
				),
			)
		for (const row of entryRows) {
			courseEntryKitSubscriberIds.add(row.externalId)
		}

		const optOutEventRows = await database
			.select({
				externalId: providerIdentity.externalId,
				contactId: providerIdentity.contactId,
				eventType: contactEvent.eventType,
				occurredAt: contactEvent.occurredAt,
			})
			.from(providerIdentity)
			.innerJoin(
				contactEvent,
				eq(contactEvent.contactId, providerIdentity.contactId),
			)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
					inArray(contactEvent.eventType, OPT_OUT_EVENT_TYPES),
				),
			)
		const intentRows = await database
			.select({
				externalId: providerIdentity.externalId,
				contactId: providerIdentity.contactId,
				type: sideEffectIntent.type,
				createdAt: sideEffectIntent.createdAt,
			})
			.from(providerIdentity)
			.innerJoin(
				sideEffectIntent,
				eq(sideEffectIntent.contactId, providerIdentity.contactId),
			)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.externalId, idChunk),
					inArray(sideEffectIntent.type, [
						UNSUBSCRIBE_KIT_LIST_INTENT_TYPE,
						SEND_VALUE_PATH_EMAIL_INTENT_TYPE,
					]),
				),
			)
		for (const id of stoppedKeys(
			optOutEventRows.map((row) => ({ ...row, key: row.externalId })),
			intentRows.map((row) => ({ ...row, key: row.externalId })),
		))
			optedOutKitSubscriberIds.add(id)
		for (const row of intentRows) {
			if (row.type !== UNSUBSCRIBE_KIT_LIST_INTENT_TYPE)
				courseHistoryKitSubscriberIds.add(row.externalId)
		}
	}

	return {
		contactEmails,
		kitSubscriberIds: matchedSubscriberIds,
		courseEntryKitSubscriberIds,
		optedOutKitSubscriberIds,
		optedOutEmails,
		courseHistoryKitSubscriberIds,
		courseHistoryEmails,
	}
}

/**
 * Consent or course-history evidence that could not be read completely.
 * The run fails rather than enter anyone on partial evidence; the Inngest
 * function's retries own the retry (the Kit reader retries only a 5xx, no
 * answer, and a 429 after its Retry-After).
 */
export class ReconcilerEvidenceUnavailableError extends Error {
	readonly source: string
	readonly reason: string

	constructor(source: string, reason: string) {
		super(
			`Confirmation reconciliation evidence unavailable: ${source}: ${reason}`,
		)
		this.name = 'ReconcilerEvidenceUnavailableError'
		this.source = source
		this.reason = reason
	}
}

function kitApiKey() {
	const apiKey =
		process.env.CONVERTKIT_V4_API_KEY ?? process.env.CONVERTKIT_API_KEY
	if (!apiKey) {
		throw new Error(
			'Confirmation reconciliation requires CONVERTKIT_V4_API_KEY or CONVERTKIT_API_KEY',
		)
	}
	return apiKey
}

/** The form's subscribers in every state, the states read in parallel. */
async function fetchKitFormSubscribersForStates(
	reader: KitReader,
	args: {
		formId: number
		addedAfter: string
		states: readonly SignupGapKitSubscriberState[]
	},
) {
	const pages = await Promise.all(
		args.states.map((state) =>
			fetchKitFormSubscribers(reader, { ...args, state }),
		),
	)
	return Array.from(
		new Map(
			pages.flat().map((record) => [record.kitSubscriberId, record]),
		).values(),
	)
}

async function fetchKitFormSubscribers(
	reader: KitReader,
	args: {
		formId: number
		addedAfter: string
		state: SignupGapKitSubscriberState
	},
) {
	const resource = `forms/${args.formId}/subscribers`
	const subscribers: KitFormSubscriberRecord[] = []
	let cursor: string | undefined
	for (let page = 0; page < 100; page++) {
		const response = await reader.get(resource, {
			status: args.state,
			per_page: '1000',
			added_after: new Date(args.addedAfter).toISOString().slice(0, 10),
			...(cursor ? { after: cursor } : {}),
		})
		if (!response.ok) {
			throw new KitReadUnavailableError(
				resource,
				`HTTP ${response.status}`,
				response.status,
			)
		}
		const payload = (await response.json().catch(() => undefined)) as
			| Record<string, unknown>
			| undefined
		if (!payload) throw new KitReadUnavailableError(resource, 'malformed page')
		subscribers.push(...parseKitFormSubscribers(payload))
		const pagination = asRecord(payload.pagination)
		if (pagination?.has_next_page !== true) return subscribers
		cursor = stringField(pagination.end_cursor)
		// A next page without a cursor would be a short list: fail instead.
		if (!cursor)
			throw new KitReadUnavailableError(resource, 'next page without a cursor')
	}
	throw new KitReadUnavailableError(resource, 'more than 100 pages')
}

function parseKitFormSubscribers(payload: unknown): KitFormSubscriberRecord[] {
	const record = asRecord(payload)
	const subscribers = Array.isArray(record?.subscribers)
		? record.subscribers
		: []
	return subscribers.flatMap((value) => {
		const subscriber = asRecord(value)
		const id =
			stringField(subscriber?.id) ??
			(typeof subscriber?.id === 'number' ? String(subscriber.id) : undefined)
		const email =
			stringField(subscriber?.email_address) ?? stringField(subscriber?.email)
		const state = stringField(subscriber?.state)
		const createdAt = stringField(subscriber?.created_at)
		const addedAt =
			stringField(subscriber?.added_at) ??
			stringField(subscriber?.subscribed_at) ??
			stringField(asRecord(subscriber?.subscription)?.created_at) ??
			createdAt
		if (
			!id ||
			!email ||
			!createdAt ||
			!addedAt ||
			!isKitSubscriberState(state)
		) {
			return []
		}
		return [
			{
				kitSubscriberId: id,
				email,
				firstName: stringField(subscriber?.first_name),
				createdAt,
				addedAt,
				state,
				fields: asRecord(subscriber?.fields),
			},
		]
	})
}

function isKitSubscriberState(
	value: string | undefined,
): value is SignupGapKitSubscriberState {
	return KIT_SUBSCRIBER_STATES.some((state) => state === value)
}

function asRecord(value: unknown) {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: undefined
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function chunk<T>(items: T[], size: number) {
	const chunks: T[][] = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}
