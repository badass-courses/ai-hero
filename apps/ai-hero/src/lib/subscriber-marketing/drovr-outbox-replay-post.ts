import {
	DrovrSignupRefusedError,
	DrovrSignupRetryableError,
	type DrovrSignupRequest,
	type DrovrSignupStatus,
} from './drovr-doi-signup'
import type { DrovrOutboxPostOutcome, DrovrOutboxRow } from './drovr-outbox'
import type {
	DrovrDeliveryConfig,
	DrovrDeliveryOutcome,
	DrovrShadowEvent,
} from './drovr-shadow-emitter'

/** A replay post waits this long for drovr before it counts as failed. */
export const DROVR_OUTBOX_POST_TIMEOUT_MS = 10_000

export type DrovrOutboxPostPorts = {
	ingestUrl: string
	apiKeyFor(tenantId: string): string | undefined
	deliver(args: {
		event: DrovrShadowEvent
		config: DrovrDeliveryConfig
		timeoutMs: number
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

async function postSignup(
	row: DrovrOutboxRow,
	ports: DrovrOutboxPostPorts,
): Promise<DrovrOutboxPostOutcome> {
	if (!ports.signup)
		return { kind: 'failed', reason: 'drovr signups are not configured' }
	try {
		await ports.signup.post(row.body as DrovrSignupRequest)
		return { kind: 'delivered', httpStatus: 200 }
	} catch (error) {
		if (error instanceof DrovrSignupRefusedError)
			return {
				kind: 'rejected',
				httpStatus: error.httpStatus,
				detail: error.message,
			}
		if (error instanceof DrovrSignupRetryableError)
			return {
				kind: 'failed',
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
 * out first; drovr dedupes any copy an earlier try already landed, so a
 * failure part-way is simply tried again whole.
 */
export async function postDrovrOutboxRow(
	row: DrovrOutboxRow,
	ports: DrovrOutboxPostPorts,
): Promise<DrovrOutboxPostOutcome> {
	if (row.endpoint === 'signups') return postSignup(row, ports)
	const base = row.body as DrovrShadowEvent
	const events = row.needsFanOut ? await ports.fanOut([base]) : [base]
	let baseRejected: { httpStatus: number; detail: unknown } | undefined
	let settled: string | undefined
	for (const event of events) {
		const apiKey = ports.apiKeyFor(event.tenantId)
		if (!apiKey)
			return {
				kind: 'failed',
				reason: `no drovr key for tenant ${event.tenantId}`,
			}
		const outcome = await ports.deliver({
			event,
			config: { ingestUrl: ports.ingestUrl, apiKey },
			timeoutMs: DROVR_OUTBOX_POST_TIMEOUT_MS,
		})
		if (outcome.status === 'failed')
			return {
				kind: 'failed',
				reason: outcome.reason,
				...(outcome.httpStatus === undefined
					? {}
					: { httpStatus: outcome.httpStatus }),
				...(outcome.retryAfterMs === undefined
					? {}
					: { retryAfterMs: outcome.retryAfterMs }),
			}
		if (outcome.status !== 'rejected') continue
		if (ports.isNeverBornOwnerStop(event, outcome)) {
			settled = 'owner-stop-never-born'
			continue
		}
		// The row's own event decides; a refused owner copy is logged by the
		// caller's rejection path only when it is the row itself.
		if (
			event.tenantId === base.tenantId &&
			event.journeyId === base.journeyId &&
			event.idempotencyKey === base.idempotencyKey
		)
			baseRejected = {
				httpStatus: outcome.httpStatus,
				detail: outcome.problem,
			}
	}
	if (baseRejected) return { kind: 'rejected', ...baseRejected }
	if (settled && !row.needsFanOut)
		return { kind: 'settled', httpStatus: 409, detail: settled }
	return { kind: 'delivered', httpStatus: 200 }
}
