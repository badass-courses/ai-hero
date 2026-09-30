import { createHash, randomUUID } from 'node:crypto'

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

/** Older rows are held for a human instead of replayed (the hawk, 09-29). */
export const DROVR_OUTBOX_AUTO_REPLAY_MAX_AGE_MS = 24 * 60 * 60_000
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
 * Which deployment's rows these are: the drovr origin plus the Vercel
 * environment (and a preview's branch). Previews share this database, so a
 * replay only ever takes its own target's rows: a preview never posts prod
 * rows to stage, nor prod a preview's rows to prod.
 */
export function drovrOutboxTarget(env: {
	DROVR_SHADOW_INGEST_URL?: string
	VERCEL_ENV?: string
	VERCEL_GIT_COMMIT_REF?: string
}): string | undefined {
	const ingestUrl = env.DROVR_SHADOW_INGEST_URL?.trim()
	if (!ingestUrl) return undefined
	let origin: string
	try {
		origin = new URL(ingestUrl).origin
	} catch {
		return undefined
	}
	const vercelEnv = env.VERCEL_ENV?.trim() || 'development'
	const scope =
		vercelEnv === 'preview' && env.VERCEL_GIT_COMMIT_REF?.trim()
			? `preview:${env.VERCEL_GIT_COMMIT_REF.trim()}`
			: vercelEnv
	return `${origin}#${scope}`.slice(0, 255)
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
}

export type DrovrOutboxStore = {
	/** Insert, ignoring a row whose dedupeKey is already there. */
	insertIgnore(rows: readonly DrovrOutboxRow[]): Promise<void>
	/** Pending rows of this target due by `now`, oldest occurredAt first. */
	due(args: {
		target: string
		now: string
		limit: number
	}): Promise<DrovrOutboxRow[]>
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

export type DrovrOutboxCapture =
	| { status: 'outboxed'; count: number }
	| { status: 'unavailable' }
	| { status: 'unconfigured' }

/**
 * Keep unsent drovr sends. `unavailable` (no table yet) and `unconfigured`
 * (no target) tell the caller to keep its previous behaviour; any other
 * store error throws, so a step retries the capture.
 */
export async function captureDrovrOutbox(args: {
	store: DrovrOutboxStore
	target: string | undefined
	entries: readonly DrovrOutboxEntry[]
	reason: unknown
	httpStatus?: number
	now: Date
	log: OutboxLog
}): Promise<DrovrOutboxCapture> {
	if (args.entries.length === 0) return { status: 'outboxed', count: 0 }
	const keys = args.entries.map((entry) => entry.idempotencyKey)
	if (!args.target) {
		await logSafely(args.log.error, 'drovr.outbox.unconfigured', {
			count: args.entries.length,
			idempotencyKeys: keys,
		})
		return { status: 'unconfigured' }
	}
	const target = args.target
	const now = args.now.toISOString()
	const lastError = bounded(errorText(args.reason))
	const rows: DrovrOutboxRow[] = args.entries.map((entry) => ({
		...entry,
		id: randomUUID(),
		dedupeKey: drovrOutboxDedupeKey(target, entry),
		target,
		status: 'pending',
		attempts: 0,
		lastStatus: args.httpStatus ?? null,
		lastError,
		firstFailedAt: now,
		nextAttemptAt: now,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: now,
	}))
	try {
		await args.store.insertIgnore(rows)
	} catch (error) {
		if (!(error instanceof DrovrOutboxUnavailableError)) throw error
		await logSafely(args.log.error, 'drovr.outbox.unavailable', {
			count: rows.length,
			source: rows[0]?.source,
			error: error.message,
			idempotencyKeys: keys,
		})
		return { status: 'unavailable' }
	}
	await logSafely(args.log.warn, 'drovr.outbox.captured', {
		count: rows.length,
		source: rows[0]?.source,
		endpoint: rows[0]?.endpoint,
		httpStatus: args.httpStatus,
		reason: lastError,
		idempotencyKeys: keys,
	})
	return { status: 'outboxed', count: rows.length }
}

export type DrovrOutboxPostOutcome =
	| { kind: 'delivered'; httpStatus?: number }
	| { kind: 'rejected'; httpStatus: number; detail: unknown }
	/** Final and expected: drovr answered, nothing to retry or alert on. */
	| { kind: 'settled'; httpStatus: number; detail: string }
	| {
			kind: 'failed'
			httpStatus?: number
			reason: string
			retryAfterMs?: number
	  }

export type DrovrOutboxReplayReceipt = {
	status: 'replayed'
	due: number
	delivered: number
	rejected: number
	failed: number
	held: number
	skippedBehindBirth: number
	circuitOpen: boolean
	budgetSpent: boolean
	purged: number
	depth: DrovrOutboxDepth
	alert: string[]
}

const isBirth = (row: DrovrOutboxRow) =>
	row.endpoint === 'signups' || row.eventType === 'contact.created'

/**
 * Order a run: oldest first, and a contact's birth before its later facts
 * when they share an instant.
 */
export function replayOrder(rows: readonly DrovrOutboxRow[]): DrovrOutboxRow[] {
	return [...rows].sort(
		(a, b) =>
			a.occurredAt.localeCompare(b.occurredAt) ||
			Number(isBirth(b)) - Number(isBirth(a)) ||
			a.id.localeCompare(b.id),
	)
}

/**
 * One replay run over this target's due rows. A row older than 24 hours
 * (by its occurredAt) that nobody released is held for a human instead of
 * posted. Once one of a contact's rows fails, the contact's later rows wait
 * for the next run, so no fact overtakes its birth. Three consecutive
 * failures open the circuit: drovr is down and the run stops asking.
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
		rejected: 0,
		failed: 0,
		held: 0,
		skippedBehindBirth: 0,
		circuitOpen: false,
		budgetSpent: false,
		purged: 0,
		depth: { pending: 0, oldestPendingFailedAt: null, held: 0, rejected: 0 },
		alert: [],
	}
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
			!row.releasedAt &&
			now.getTime() - Date.parse(row.occurredAt) >
				DROVR_OUTBOX_AUTO_REPLAY_MAX_AGE_MS
		) {
			await args.store.update(row.id, { status: 'held' })
			receipt.held += 1
			blockedContacts.add(row.contactId)
			await logSafely(args.log.warn, 'drovr.outbox.held', {
				...fields,
				occurredAt: row.occurredAt,
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
			outcome = { kind: 'failed', reason: errorText(error) }
		}
		const attempts = row.attempts + 1
		const at = args.now().toISOString()
		if (outcome.kind === 'delivered' || outcome.kind === 'settled') {
			consecutiveFailures = 0
			receipt.delivered += 1
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
			})
			continue
		}
		consecutiveFailures += 1
		receipt.failed += 1
		blockedContacts.add(row.contactId)
		await args.store.update(row.id, {
			attempts,
			lastStatus: outcome.httpStatus ?? null,
			lastError: bounded(outcome.reason),
			lastAttemptAt: at,
			nextAttemptAt: new Date(
				Date.parse(at) + drovrReplayDelayMs(attempts, outcome.retryAfterMs),
			).toISOString(),
		})
		await logSafely(args.log.warn, 'drovr.outbox.retry_later', {
			...fields,
			attempts,
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
	const depthFields = {
		target: args.target,
		pending: receipt.depth.pending,
		oldestPendingAgeMin: Math.round(oldestAgeMs / 60_000),
		held: receipt.depth.held,
		rejected: receipt.depth.rejected,
		ranDelivered: receipt.delivered,
		ranFailed: receipt.failed,
		ranHeld: receipt.held,
		ranRejected: receipt.rejected,
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
