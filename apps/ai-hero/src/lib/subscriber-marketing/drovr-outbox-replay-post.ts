import { admitValuePathBirths } from './drovr-value-path-birth-admission'
import {
	DrovrSignupRefusedError,
	DrovrSignupRetryableError,
	type DrovrSignupRequest,
	type DrovrSignupStatus,
} from './drovr-doi-signup'
import type { DrovrOutboxPostOutcome, DrovrOutboxRow } from './drovr-outbox'
import {
	DROVR_SHADOW_TENANT_ID,
	type DrovrDeliveryConfig,
	type DrovrDeliveryOutcome,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

/** A replay post waits this long for drovr before it counts as failed. */
export const DROVR_OUTBOX_POST_TIMEOUT_MS = 10_000

export type DrovrOutboxPostPorts = {
	ingestUrl: string
	readBirthOptOuts(contactIds: readonly string[]): Promise<readonly string[]>
	info(event: string, fields: Record<string, unknown>): unknown
	apiKeyFor(tenantId: string): string | undefined
	deliver(args: {
		event: DrovrShadowEvent
		config: DrovrDeliveryConfig
		timeoutMs: number
		clampAt: number
	}): Promise<DrovrDeliveryOutcome>
	/** An unfanned row's events with their owner copies (the live fan-out). */
	fanOut(events: readonly DrovrShadowEvent[]): Promise<DrovrShadowEvent[]>
	/** drovr's answer to an owner stop for a contact never born there. */
	isNeverBornOwnerStop(
		event: DrovrShadowEvent,
		outcome: DrovrDeliveryOutcome,
	): boolean
	signup?: {
		post(request: DrovrSignupRequest): Promise<DrovrSignupStatus>
	}
}

/** drovr down or unreachable, as opposed to a verdict or a config gap. */
const isTransientStatus = (httpStatus: number | undefined) =>
	httpStatus === undefined ||
	httpStatus >= 500 ||
	httpStatus === 408 ||
	httpStatus === 429

async function postSignup(
	row: DrovrOutboxRow,
	ports: DrovrOutboxPostPorts,
): Promise<DrovrOutboxPostOutcome> {
	if (!ports.signup)
		return {
			kind: 'failed',
			transient: false,
			reason: 'drovr signups are not configured',
		}
	try {
		await ports.signup.post(row.body as DrovrSignupRequest)
		return { kind: 'delivered', httpStatus: 200 }
	} catch (error) {
		if (error instanceof DrovrSignupRefusedError)
			return {
				kind: 'rejected',
				httpStatus: error.httpStatus,
				detail: error.message,
				idempotencyKey: row.idempotencyKey,
			}
		if (error instanceof DrovrSignupRetryableError)
			return {
				kind: 'failed',
				transient: isTransientStatus(error.httpStatus),
				reason: error.message,
				...(error.httpStatus === undefined
					? {}
					: { httpStatus: error.httpStatus }),
				...(error.retryAfterMs === undefined
					? {}
					: { retryAfterMs: error.retryAfterMs }),
			}
		throw error
	}
}

/**
 * One outbox row, re-posted under its own key(s). An unfanned row is fanned
 * out first, and then, as live delivery does, every event addressed to the
 * retired shadow tenant is dropped: drovr has no key for it, and what the
 * row owes is its owner copies. A row with nothing deliverable left is
 * settled (no owner copy owed). drovr dedupes any copy an earlier try
 * already landed, so a failure part-way is simply tried again whole.
 *
 * Births are clamped at the row's `firstFailedAt` (row 201g): the first
 * failed send's instant, or the capture's for a row never sent. So every
 * replay keeps that first instant, and an owner copy the fan-out makes is
 * clamped as its original was. Directory births recheck stop standing and
 * may upgrade a provisional payload to stopped, without changing its key.
 *
 * The row's verdict: a failure → failed (transient for a 5xx, a timeout or
 * no answer; not for a missing key or a 409 event-not-live); else any
 * refusal of the row or of an owner copy → rejected, with that event's
 * key; else anything accepted → delivered; else (owner stops for contacts
 * never born there) → settled.
 */
export async function postDrovrOutboxRow(
	row: DrovrOutboxRow,
	ports: DrovrOutboxPostPorts,
): Promise<DrovrOutboxPostOutcome> {
	if (row.endpoint === 'signups') return postSignup(row, ports)
	const base = row.body as DrovrShadowEvent
	const fanned = row.needsFanOut ? await ports.fanOut([base]) : [base]
	const admitted = await admitValuePathBirths({
		events: fanned.filter((event) => event.tenantId !== DROVR_SHADOW_TENANT_ID),
		read: ports.readBirthOptOuts,
		info: ports.info,
	})
	const events = admitted.events
	if (events.length === 0)
		return {
			kind: 'settled',
			detail:
				admitted.skipped > 0
					? 'value-path-birth-unsubscribed'
					: 'nothing-deliverable',
		}
	let accepted = 0
	let rejected:
		| { httpStatus: number; detail: unknown; idempotencyKey: string }
		| undefined
	for (const event of events) {
		const apiKey = ports.apiKeyFor(event.tenantId)
		if (!apiKey)
			return {
				kind: 'failed',
				transient: false,
				reason: `no drovr key for tenant ${event.tenantId}`,
			}
		const outcome = await ports.deliver({
			event,
			config: { ingestUrl: ports.ingestUrl, apiKey },
			timeoutMs: DROVR_OUTBOX_POST_TIMEOUT_MS,
			clampAt: Date.parse(row.firstFailedAt),
		})
		if (outcome.status === 'failed')
			return {
				kind: 'failed',
				transient: isTransientStatus(outcome.httpStatus),
				reason: outcome.reason,
				...(outcome.httpStatus === undefined
					? {}
					: { httpStatus: outcome.httpStatus }),
				...(outcome.retryAfterMs === undefined
					? {}
					: { retryAfterMs: outcome.retryAfterMs }),
			}
		if (outcome.status === 'accepted') {
			accepted += 1
			continue
		}
		if (ports.isNeverBornOwnerStop(event, outcome)) continue
		rejected ??= {
			httpStatus: outcome.httpStatus,
			detail: outcome.problem,
			idempotencyKey: event.idempotencyKey,
		}
	}
	if (rejected) return { kind: 'rejected', ...rejected }
	if (accepted > 0) return { kind: 'delivered', httpStatus: 200 }
	return { kind: 'settled', httpStatus: 409, detail: 'owner-stop-never-born' }
}
