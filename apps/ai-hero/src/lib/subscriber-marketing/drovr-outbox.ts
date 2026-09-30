import { createHash, randomUUID } from 'node:crypto'

import { CONTACT_STOP_EVENT_TYPES } from './contact-stop-rule'
import type { DrovrSignupRequest } from './drovr-doi-signup'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * Row 204: AI Hero never loses a drovr send.
 *
 * A send that runs out of retries (a sustained drovr 5xx or outage), or a
 * direct fallback post that drovr answers 5xx, lands in AI_DrovrOutbox with
 * its exact body. The replay cron re-posts it under the same drovr
 * idempotency key until drovr answers 2xx; drovr dedupes a repeat, so
 * re-posting one that did land is harmless.
 */

/** Inngest retries on every drovr-send function (was 6). */
export const DROVR_SEND_RETRIES = 8

/**
 * Inngest's step backoff, mirrored as the floor of every retry delay. Its
 * sum, 78.75 minutes over eight retries, outlasts a 60-minute drovr
 * overload; the outbox takes whatever outlasts that.
 */
export const DROVR_SEND_BACKOFF_MS = [
	15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 2_400_000,
] as const

/** A step retry honours Retry-After up to this, never below the table. */
export const DROVR_RETRY_AFTER_STEP_CAP_MS = 10 * 60_000
/** A replay honours Retry-After up to this, never below its own backoff. */
export const DROVR_RETRY_AFTER_REPLAY_CAP_MS = 15 * 60_000
export const DROVR_OUTBOX_REPLAY_MAX_BACKOFF_MS = 60 * 60_000

/**
 * A birth that has failed to land for longer than this is held for a human
 * instead of replayed (the hawk, 09-29): a days-late birth would start a
 * journey's emails days late. Facts (stops, purchases, answers) are never
 * held: delivered late they are still right.
 */
export const DROVR_OUTBOX_AUTO_REPLAY_MAX_AGE_MS = 24 * 60 * 60_000
/** How long a fact waits when its birth is held (a human decides). */
export const DROVR_OUTBOX_HELD_BIRTH_WAIT_MS = 60 * 60_000
/**
 * How far a fact behind a rejected stop moves each run. The stop stays
 * rejected until a human releases or retires it, so the fact keeps waiting.
 */
export const DROVR_OUTBOX_REJECTED_STOP_WAIT_MS = 60 * 60_000
/** A stop still owed after this long alerts (two replay runs), row 204b. */
export const DROVR_OUTBOX_STOP_ALERT_MS = 10 * 60_000
/** Capture tries before the step gives up (the keys are logged first). */
export const DROVR_OUTBOX_CAPTURE_TRIES = 3
/** Delivered rows are deleted after this: the inline body holds contact data. */
export const DROVR_OUTBOX_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000
export const DROVR_OUTBOX_REPLAY_BATCH = 50
export const DROVR_OUTBOX_CIRCUIT_BREAK_AFTER = 3
/** Stop taking rows once a run has spent this long (Vercel's clock). */
export const DROVR_OUTBOX_REPLAY_BUDGET_MS = 90_000
export const DROVR_OUTBOX_PURGE_BATCH = 500
export const DROVR_OUTBOX_ALERT_PENDING = 25
export const DROVR_OUTBOX_ALERT_OLDEST_MS = 60 * 60_000

/**
 * The retry delay for a failed drovr send on a zero-indexed attempt: the
 * table's delay, or drovr's Retry-After (capped) if longer. A 5 to 30
 * second Retry-After taken as-is would spend eight retries in four minutes.
 */
export function drovrRetryDelayMs(
	attempt: number,
	retryAfterMs?: number,
): number {
	const floor =
		DROVR_SEND_BACKOFF_MS[
			Math.min(Math.max(attempt, 0), DROVR_SEND_BACKOFF_MS.length - 1)
		]!
	const hinted =
		retryAfterMs === undefined || !Number.isFinite(retryAfterMs)
			? 0
			: Math.min(Math.max(retryAfterMs, 0), DROVR_RETRY_AFTER_STEP_CAP_MS)
	return Math.max(floor, hinted)
}

/** A replay's next attempt, after `attempts` failed posts. */
export function drovrReplayDelayMs(
	attempts: number,
	retryAfterMs?: number,
): number {
	const exponential = Math.min(
		2 ** Math.max(attempts - 1, 0) * 60_000,
		DROVR_OUTBOX_REPLAY_MAX_BACKOFF_MS,
	)
	const hinted =
		retryAfterMs === undefined || !Number.isFinite(retryAfterMs)
			? 0
			: Math.min(Math.max(retryAfterMs, 0), DROVR_RETRY_AFTER_REPLAY_CAP_MS)
	return Math.max(exponential, hinted)
}

export { parseRetryAfterMs } from './drovr-retry-after'

export type DrovrOutboxEndpoint = 'events' | 'signups'
export type DrovrOutboxSource =
	| 'live'
	| 'bulk'
	| 'signup'
	| 'fallback'
	| 'onFailure'
	| 'contactSync'
export type DrovrOutboxStatus = 'pending' | 'delivered' | 'rejected' | 'held'

export type DrovrOutboxEntry = {
	endpoint: DrovrOutboxEndpoint
	tenantId: string
	contactId: string
	journeyId: string
	eventType: string
	idempotencyKey: string
	body: DrovrShadowEvent | DrovrSignupRequest
	occurredAt: string
	/** Captured before the owner fan-out: the replay fans it out. */
	needsFanOut: boolean
	source: DrovrOutboxSource
}

export type DrovrOutboxRow = DrovrOutboxEntry & {
	id: string
	dedupeKey: string
	target: string
	status: DrovrOutboxStatus
	attempts: number
	lastStatus: number | null
	lastError: string | null
	firstFailedAt: string
	nextAttemptAt: string
	lastAttemptAt: string | null
	deliveredAt: string | null
	releasedAt: string | null
	createdAt: string
}

export function outboxEntryForEvent(
	event: DrovrShadowEvent,
	source: DrovrOutboxSource,
	options: { needsFanOut?: boolean } = {},
): DrovrOutboxEntry {
	return {
		endpoint: 'events',
		tenantId: event.tenantId,
		contactId: event.contactId,
		journeyId: event.journeyId,
		eventType: event.type,
		idempotencyKey: event.idempotencyKey,
		body: event,
		occurredAt: event.occurredAt,
		needsFanOut: options.needsFanOut ?? false,
		source,
	}
}

export function outboxEntryForSignup(
	request: DrovrSignupRequest,
): DrovrOutboxEntry {
	return {
		endpoint: 'signups',
		tenantId: request.tenantId,
		contactId: request.contactId,
		journeyId: `signup:${request.formId}`,
		eventType: 'signup',
		idempotencyKey: request.submissionId,
		body: request,
		occurredAt: request.occurredAt,
		needsFanOut: false,
		source: 'signup',
	}
}

/**
 * Which deployment's rows these are: the Vercel environment, and a
 * preview's branch. Previews share this database, so a replay only ever
 * takes its own target's rows: a preview never posts prod rows, nor prod a
 * preview's. The drovr URL is deliberately not part of it: an ingest URL
 * change (the stage proof's stub origin and back) must not orphan rows.
 */
export function drovrOutboxTarget(env: {
	VERCEL_ENV?: string
	VERCEL_GIT_COMMIT_REF?: string
}): string {
	const vercelEnv = env.VERCEL_ENV?.trim() || 'development'
	const scope =
		vercelEnv === 'preview' && env.VERCEL_GIT_COMMIT_REF?.trim()
			? `preview:${env.VERCEL_GIT_COMMIT_REF.trim()}`
			: vercelEnv
	return scope.slice(0, 255)
}

/** One row per (target, endpoint, tenant, contact, journey, key). */
export function drovrOutboxDedupeKey(
	target: string,
	entry: Pick<
		DrovrOutboxEntry,
		'endpoint' | 'tenantId' | 'contactId' | 'journeyId' | 'idempotencyKey'
	>,
): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				target,
				entry.endpoint,
				entry.tenantId,
				entry.contactId,
				entry.journeyId,
				entry.idempotencyKey,
			]),
		)
		.digest('hex')
}

/** The outbox table is not there yet (the deploy request is not applied). */
export class DrovrOutboxUnavailableError extends Error {
	constructor(cause: unknown) {
		super(
			`drovr outbox table unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
		)
		this.name = 'DrovrOutboxUnavailableError'
	}
}

export type DrovrOutboxDepth = {
	pending: number
	oldestPendingFailedAt: string | null
	held: number
	rejected: number
	/** The oldest stop still owed (pending or rejected), row 204b. */
	oldestOpenStopFailedAt: string | null
}

/**
 * A row later rows wait for: a birth still owed (pending or held), or a
 * stop still owed (pending, held or rejected: a refused stop fails closed).
 */
export type DrovrOutboxOpenGate = Pick<
	DrovrOutboxRow,
	| 'contactId'
	| 'journeyId'
	| 'endpoint'
	| 'eventType'
	| 'status'
	| 'nextAttemptAt'
	| 'occurredAt'
>

export type DrovrOutboxStore = {
	/** Insert; a row whose dedupeKey is already there is left as it is. */
	insertIgnore(rows: readonly DrovrOutboxRow[]): Promise<void>
	/** Pending rows of this target due by `now`, oldest nextAttemptAt first. */
	due(args: {
		target: string
		now: string
		limit: number
	}): Promise<DrovrOutboxRow[]>
	/**
	 * This target's open gates for these contacts: pending or held births,
	 * and pending, held or rejected stops.
	 */
	openGates(args: {
		target: string
		contactIds: readonly string[]
	}): Promise<DrovrOutboxOpenGate[]>
	update(
		id: string,
		patch: Partial<
			Pick<
				DrovrOutboxRow,
				| 'status'
				| 'attempts'
				| 'lastStatus'
				| 'lastError'
				| 'nextAttemptAt'
				| 'lastAttemptAt'
				| 'deliveredAt'
			>
		>,
	): Promise<void>
	depth(target: string): Promise<DrovrOutboxDepth>
	/** Delivered rows only; held and rejected rows stay until resolved. */
	deleteDeliveredBefore(before: string, limit: number): Promise<number>
}

type OutboxLog = {
	info(event: string, fields: Record<string, unknown>): unknown
	warn(event: string, fields: Record<string, unknown>): unknown
	error(event: string, fields: Record<string, unknown>): unknown
}

async function logSafely(
	write: (event: string, fields: Record<string, unknown>) => unknown,
	event: string,
	fields: Record<string, unknown>,
): Promise<void> {
	try {
		await write(event, fields)
	} catch {
		// Logging cannot change what the outbox decided.
	}
}

const bounded = (text: string, max = 1000) =>
	text.length > max ? text.slice(0, max) : text

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error)

const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))

export type DrovrOutboxCapture =
	| { status: 'outboxed'; count: number }
	| { status: 'unavailable' }
	| { status: 'unconfigured' }

/**
 * Keep unsent drovr sends. The keys are logged before the write, so even a
 * capture that fails for good leaves them in the logs; a store error is
 * retried in place (DROVR_OUTBOX_CAPTURE_TRIES) and then thrown, so the
 * step fails loudly. `unavailable` (no table yet) and `unconfigured` (no
 * target) tell the caller to keep its previous behaviour. An empty capture
 * is logged too, with its count of 0.
 */
export async function captureDrovrOutbox(args: {
	store: DrovrOutboxStore
	target: string | undefined
	entries: readonly DrovrOutboxEntry[]
	reason: unknown
	httpStatus?: number
	now: Date
	log: OutboxLog
	sleep?: (ms: number) => Promise<void>
}): Promise<DrovrOutboxCapture> {
	const keys = args.entries.map((entry) => entry.idempotencyKey)
	const reason = bounded(errorText(args.reason))
	const summary = {
		count: args.entries.length,
		source: args.entries[0]?.source,
		endpoint: args.entries[0]?.endpoint,
		needsFanOut: args.entries.filter((entry) => entry.needsFanOut).length,
		httpStatus: args.httpStatus,
		reason,
		idempotencyKeys: keys,
	}
	if (args.entries.length === 0) {
		await logSafely(args.log.warn, 'drovr.outbox.captured', summary)
		return { status: 'outboxed', count: 0 }
	}
	if (!args.target) {
		await logSafely(args.log.error, 'drovr.outbox.unconfigured', summary)
		return { status: 'unconfigured' }
	}
	const target = args.target
	const now = args.now.toISOString()
	const rows: DrovrOutboxRow[] = args.entries.map((entry) => ({
		...entry,
		id: randomUUID(),
		dedupeKey: drovrOutboxDedupeKey(target, entry),
		target,
		status: 'pending',
		attempts: 0,
		lastStatus: args.httpStatus ?? null,
		lastError: reason,
		firstFailedAt: now,
		nextAttemptAt: now,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: now,
	}))
	await logSafely(args.log.warn, 'drovr.outbox.capturing', summary)
	const sleep = args.sleep ?? pause
	for (let attempt = 1; ; attempt += 1) {
		try {
			await args.store.insertIgnore(rows)
			break
		} catch (error) {
			if (error instanceof DrovrOutboxUnavailableError) {
				await logSafely(args.log.error, 'drovr.outbox.unavailable', {
					...summary,
					error: error.message,
				})
				return { status: 'unavailable' }
			}
			if (attempt >= DROVR_OUTBOX_CAPTURE_TRIES) {
				await logSafely(args.log.error, 'drovr.outbox.capture_failed', {
					...summary,
					tries: attempt,
					error: errorText(error),
				})
				throw error
			}
			await sleep(250 * attempt)
		}
	}
	await logSafely(args.log.warn, 'drovr.outbox.captured', summary)
	return { status: 'outboxed', count: rows.length }
}

export type DrovrOutboxPostOutcome =
	| { kind: 'delivered'; httpStatus?: number }
	/** A 4xx for the row or one of its owner copies: final, alerted. */
	| {
			kind: 'rejected'
			httpStatus: number
			detail: unknown
			idempotencyKey?: string
	  }
	/** Final and expected: nothing owed, nothing to retry or alert on. */
	| { kind: 'settled'; detail: string; httpStatus?: number }
	| {
			kind: 'failed'
			/** A 5xx, a timeout or no answer: the only failures the breaker counts. */
			transient: boolean
			httpStatus?: number
			reason: string
			retryAfterMs?: number
	  }

export type DrovrOutboxReplayReceipt = {
	status: 'replayed'
	due: number
	delivered: number
	settled: number
	rejected: number
	failed: number
	held: number
	skippedBehindBirth: number
	skippedBehindStop: number
	circuitOpen: boolean
	budgetSpent: boolean
	purged: number
	depth: DrovrOutboxDepth
	alert: string[]
}

/** A birth: a contact.created event, or a signup (its directory birth). */
export const isOutboxBirth = (
	row: Pick<DrovrOutboxRow, 'endpoint' | 'eventType'>,
) => row.endpoint === 'signups' || row.eventType === 'contact.created'

/**
 * The stops (row 204b): once one is owed, nothing the contact did after it
 * may reach drovr first. Unsubscribe, bounce and complaint are also refused
 * at send time by ai-hero (contact-stop-rule) and by Kit; a purchase is
 * refused by nothing but drovr knowing, so it is the one that matters most.
 * The evergreen same-offer purchase is a `purchase.recorded` too.
 */
export const DROVR_OUTBOX_STOP_EVENT_TYPES = [
	...CONTACT_STOP_EVENT_TYPES,
	'purchase.recorded',
] as const

export const isOutboxStop = (row: Pick<DrovrOutboxRow, 'eventType'>) =>
	(DROVR_OUTBOX_STOP_EVENT_TYPES as readonly string[]).includes(row.eventType)

/**
 * The open stop a row waits behind: the contact's earliest stop still owed
 * that happened at or before it, on any journey. A stop never waits behind
 * a stop, and an earlier row never waits for a later stop.
 */
export function openStopBefore<S extends Pick<DrovrOutboxRow, 'occurredAt'>>(
	row: Pick<DrovrOutboxRow, 'eventType' | 'occurredAt'>,
	stops: readonly S[] | undefined,
): S | undefined {
	if (!stops || isOutboxStop(row)) return undefined
	const at = Date.parse(row.occurredAt)
	return stops
		.filter((stop) => Date.parse(stop.occurredAt) <= at)
		.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0]
}

/**
 * What a birth row gates: facts on its journey, or, for a signup, every
 * row of the contact.
 */
const birthGateKey = (
	birth: Pick<DrovrOutboxRow, 'contactId' | 'journeyId' | 'endpoint'>,
) =>
	birth.endpoint === 'signups'
		? `${birth.contactId}|*`
		: `${birth.contactId}|${birth.journeyId}`

/**
 * Order a run: oldest first, and a contact's birth before its later facts
 * when they share an instant.
 */
export function replayOrder(rows: readonly DrovrOutboxRow[]): DrovrOutboxRow[] {
	return [...rows].sort(
		(a, b) =>
			a.occurredAt.localeCompare(b.occurredAt) ||
			Number(isOutboxBirth(b)) - Number(isOutboxBirth(a)) ||
			a.id.localeCompare(b.id),
	)
}

/**
 * One replay run over this target's due rows.
 *
 * - A birth that has failed to land for over 24 hours (firstFailedAt) and
 *   that nobody released is held for a human instead of posted.
 * - A birth gates its contact: no fact on its journey (every row, for a
 *   signup) posts while the birth is pending or held, in this run or any
 *   later one, so a fact never overtakes its birth into drovr's 409
 *   contact-never-born. A gated fact is moved to its birth's next attempt.
 * - A stop gates its contact (row 204b): nothing that happened at or after
 *   an owed stop (pending, or rejected until a human acts) posts, on any
 *   journey, in this run or a later one. A gated row moves to the stop's
 *   next attempt, or an hour on behind a rejected stop. A stop owed for
 *   over 10 minutes alerts.
 * - Once one of a contact's rows fails, its later rows wait for the next
 *   run.
 * - Three consecutive transient failures (5xx, timeout, no answer) open the
 *   circuit: drovr is down and the run stops asking. A missing key, a 409
 *   event-not-live or a 4xx is not drovr being down and never counts.
 */
export async function runDrovrOutboxReplay(args: {
	store: DrovrOutboxStore
	target: string
	now: () => Date
	post(row: DrovrOutboxRow): Promise<DrovrOutboxPostOutcome>
	log: OutboxLog
	limit?: number
	budgetMs?: number
}): Promise<DrovrOutboxReplayReceipt> {
	const startedAt = args.now()
	const due = replayOrder(
		await args.store.due({
			target: args.target,
			now: startedAt.toISOString(),
			limit: args.limit ?? DROVR_OUTBOX_REPLAY_BATCH,
		}),
	)
	const receipt: DrovrOutboxReplayReceipt = {
		status: 'replayed',
		due: due.length,
		delivered: 0,
		settled: 0,
		rejected: 0,
		failed: 0,
		held: 0,
		skippedBehindBirth: 0,
		skippedBehindStop: 0,
		circuitOpen: false,
		budgetSpent: false,
		purged: 0,
		depth: {
			pending: 0,
			oldestPendingFailedAt: null,
			held: 0,
			rejected: 0,
			oldestOpenStopFailedAt: null,
		},
		alert: [],
	}
	// Every birth and stop still owed for these contacts, due now or not.
	const openBirths = new Map<string, DrovrOutboxOpenGate>()
	const openStops = new Map<
		string,
		(DrovrOutboxOpenGate & { key?: string })[]
	>()
	const gates =
		due.length === 0
			? []
			: await args.store.openGates({
					target: args.target,
					contactIds: [...new Set(due.map((row) => row.contactId))],
				})
	for (const gate of gates) {
		if (isOutboxStop(gate)) {
			const list = openStops.get(gate.contactId) ?? []
			list.push(gate)
			openStops.set(gate.contactId, list)
		} else if (isOutboxBirth(gate)) openBirths.set(birthGateKey(gate), gate)
	}
	// This run's own stops, by row: an outcome updates the gate they left.
	const stopOf = (row: DrovrOutboxRow) =>
		openStops
			.get(row.contactId)
			?.find(
				(stop) =>
					stop.eventType === row.eventType &&
					stop.journeyId === row.journeyId &&
					stop.occurredAt === row.occurredAt,
			)
	const settleStop = (row: DrovrOutboxRow) => {
		const stop = stopOf(row)
		if (!stop) return
		const list = openStops.get(row.contactId)!
		list.splice(list.indexOf(stop), 1)
	}
	const gateOf = (row: DrovrOutboxRow) =>
		isOutboxBirth(row)
			? undefined
			: (openBirths.get(birthGateKey(row)) ??
				openBirths.get(`${row.contactId}|*`))

	const blockedContacts = new Set<string>()
	let consecutiveFailures = 0
	for (const row of due) {
		const now = args.now()
		if (
			now.getTime() - startedAt.getTime() >=
			(args.budgetMs ?? DROVR_OUTBOX_REPLAY_BUDGET_MS)
		) {
			receipt.budgetSpent = true
			break
		}
		const fields = {
			outboxId: row.id,
			contactId: row.contactId,
			journeyId: row.journeyId,
			eventType: row.eventType,
			idempotencyKey: row.idempotencyKey,
			source: row.source,
		}
		if (
			isOutboxBirth(row) &&
			!row.releasedAt &&
			now.getTime() - Date.parse(row.firstFailedAt) >
				DROVR_OUTBOX_AUTO_REPLAY_MAX_AGE_MS
		) {
			await args.store.update(row.id, { status: 'held' })
			openBirths.set(birthGateKey(row), { ...row, status: 'held' })
			receipt.held += 1
			blockedContacts.add(row.contactId)
			await logSafely(args.log.warn, 'drovr.outbox.held', {
				...fields,
				firstFailedAt: row.firstFailedAt,
			})
			continue
		}
		const gate = gateOf(row)
		if (gate) {
			receipt.skippedBehindBirth += 1
			const after =
				gate.status === 'held'
					? new Date(
							now.getTime() + DROVR_OUTBOX_HELD_BIRTH_WAIT_MS,
						).toISOString()
					: gate.nextAttemptAt
			if (after > row.nextAttemptAt)
				await args.store.update(row.id, { nextAttemptAt: after })
			if (isOutboxStop(row)) {
				const stop = stopOf(row)
				if (stop && after > stop.nextAttemptAt) stop.nextAttemptAt = after
			}
			continue
		}
		const stop = openStopBefore(row, openStops.get(row.contactId))
		if (stop) {
			receipt.skippedBehindStop += 1
			const after =
				stop.status === 'pending'
					? stop.nextAttemptAt
					: new Date(
							now.getTime() + DROVR_OUTBOX_REJECTED_STOP_WAIT_MS,
						).toISOString()
			if (after > row.nextAttemptAt)
				await args.store.update(row.id, { nextAttemptAt: after })
			await logSafely(args.log.info, 'drovr.outbox.behind_stop', {
				...fields,
				stopEventType: stop.eventType,
				stopStatus: stop.status,
			})
			continue
		}
		if (blockedContacts.has(row.contactId)) {
			receipt.skippedBehindBirth += 1
			continue
		}
		let outcome: DrovrOutboxPostOutcome
		try {
			outcome = await args.post(row)
		} catch (error) {
			outcome = { kind: 'failed', transient: true, reason: errorText(error) }
		}
		const attempts = row.attempts + 1
		const at = args.now().toISOString()
		if (outcome.kind === 'delivered' || outcome.kind === 'settled') {
			consecutiveFailures = 0
			receipt[outcome.kind] += 1
			if (isOutboxBirth(row)) openBirths.delete(birthGateKey(row))
			if (isOutboxStop(row)) settleStop(row)
			await args.store.update(row.id, {
				status: 'delivered',
				attempts,
				lastStatus: outcome.httpStatus ?? null,
				lastError: outcome.kind === 'settled' ? outcome.detail : null,
				lastAttemptAt: at,
				deliveredAt: at,
			})
			await logSafely(args.log.info, 'drovr.outbox.delivered', {
				...fields,
				attempts,
				...(outcome.kind === 'settled' ? { settled: outcome.detail } : {}),
			})
			continue
		}
		if (outcome.kind === 'rejected') {
			consecutiveFailures = 0
			receipt.rejected += 1
			blockedContacts.add(row.contactId)
			if (isOutboxStop(row)) {
				const stop = stopOf(row)
				if (stop) stop.status = 'rejected'
			}
			await args.store.update(row.id, {
				status: 'rejected',
				attempts,
				lastStatus: outcome.httpStatus,
				lastError: bounded(JSON.stringify(outcome.detail ?? null)),
				lastAttemptAt: at,
			})
			await logSafely(args.log.error, 'drovr.outbox.rejected', {
				...fields,
				httpStatus: outcome.httpStatus,
				detail: outcome.detail,
				...(outcome.idempotencyKey &&
				outcome.idempotencyKey !== row.idempotencyKey
					? { rejectedCopyKey: outcome.idempotencyKey }
					: {}),
			})
			continue
		}
		if (outcome.transient) consecutiveFailures += 1
		receipt.failed += 1
		blockedContacts.add(row.contactId)
		const nextAttemptAt = new Date(
			Date.parse(at) + drovrReplayDelayMs(attempts, outcome.retryAfterMs),
		).toISOString()
		if (isOutboxBirth(row) && openBirths.has(birthGateKey(row)))
			openBirths.set(birthGateKey(row), { ...row, nextAttemptAt })
		if (isOutboxStop(row)) {
			const stop = stopOf(row)
			if (stop) stop.nextAttemptAt = nextAttemptAt
		}
		await args.store.update(row.id, {
			attempts,
			lastStatus: outcome.httpStatus ?? null,
			lastError: bounded(outcome.reason),
			lastAttemptAt: at,
			nextAttemptAt,
		})
		await logSafely(args.log.warn, 'drovr.outbox.retry_later', {
			...fields,
			attempts,
			transient: outcome.transient,
			httpStatus: outcome.httpStatus,
			reason: outcome.reason,
		})
		if (consecutiveFailures >= DROVR_OUTBOX_CIRCUIT_BREAK_AFTER) {
			receipt.circuitOpen = true
			break
		}
	}

	const now = args.now()
	receipt.purged = await args.store.deleteDeliveredBefore(
		new Date(now.getTime() - DROVR_OUTBOX_DELIVERED_RETENTION_MS).toISOString(),
		DROVR_OUTBOX_PURGE_BATCH,
	)
	receipt.depth = await args.store.depth(args.target)
	const oldestAgeMs = receipt.depth.oldestPendingFailedAt
		? now.getTime() - Date.parse(receipt.depth.oldestPendingFailedAt)
		: 0
	if (receipt.depth.pending > DROVR_OUTBOX_ALERT_PENDING)
		receipt.alert.push('pending')
	if (oldestAgeMs > DROVR_OUTBOX_ALERT_OLDEST_MS) receipt.alert.push('oldest')
	if (receipt.held > 0) receipt.alert.push('held')
	if (receipt.rejected > 0) receipt.alert.push('rejected')
	const openStopAgeMs = receipt.depth.oldestOpenStopFailedAt
		? now.getTime() - Date.parse(receipt.depth.oldestOpenStopFailedAt)
		: 0
	if (openStopAgeMs > DROVR_OUTBOX_STOP_ALERT_MS) receipt.alert.push('stop')
	const depthFields = {
		target: args.target,
		pending: receipt.depth.pending,
		oldestPendingAgeMin: Math.round(oldestAgeMs / 60_000),
		held: receipt.depth.held,
		rejected: receipt.depth.rejected,
		oldestOpenStopAgeMin: Math.round(openStopAgeMs / 60_000),
		ranDelivered: receipt.delivered,
		ranSettled: receipt.settled,
		ranFailed: receipt.failed,
		ranHeld: receipt.held,
		ranRejected: receipt.rejected,
		ranSkippedBehindBirth: receipt.skippedBehindBirth,
		ranSkippedBehindStop: receipt.skippedBehindStop,
		circuitOpen: receipt.circuitOpen,
		purged: receipt.purged,
	}
	await logSafely(args.log.info, 'drovr.outbox.depth', depthFields)
	if (receipt.alert.length > 0)
		await logSafely(args.log.error, 'drovr.outbox.alert', {
			...depthFields,
			reasons: receipt.alert,
		})
	return receipt
}
