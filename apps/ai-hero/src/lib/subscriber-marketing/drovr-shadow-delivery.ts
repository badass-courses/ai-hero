import { log } from '@/server/logger'

import {
	boundedProblemBody,
	deliverDrovrShadowEvent,
	type DrovrDeliveryConfig,
	type DrovrDeliveryOutcome,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

export class DrovrDeliveryFailedError extends Error {
	constructor(
		readonly idempotencyKey: string,
		readonly reason: string,
	) {
		super(`drovr delivery failed for ${idempotencyKey}: ${reason}`)
		this.name = 'DrovrDeliveryFailedError'
	}
}

/**
 * One event through one attempt, as the step body. `failed` throws so
 * Inngest retries the step with backoff; `rejected` is final and is
 * logged, never retried; `accepted` returns. Pure over its inputs so it
 * can be tested without the function runtime.
 */
export async function deliverOrThrow(args: {
	event: DrovrShadowEvent
	config: DrovrDeliveryConfig
	fetcher?: typeof fetch
	warn?: typeof log.warn
}): Promise<DrovrDeliveryOutcome> {
	const outcome = await deliverDrovrShadowEvent({
		event: args.event,
		config: args.config,
		fetcher: args.fetcher,
	})
	if (outcome.status === 'failed') {
		throw new DrovrDeliveryFailedError(
			args.event.idempotencyKey,
			outcome.reason,
		)
	}
	if (outcome.status === 'rejected') {
		const warn = args.warn ?? log.warn
		try {
			await warn('drovr.shadow.rejected', {
				status: outcome.httpStatus,
				journeyId: args.event.journeyId,
				type: args.event.type,
				idempotencyKey: args.event.idempotencyKey,
				problem: outcome.problem,
			})
		} catch {
			// Logging cannot change the delivery result.
		}
	}
	return outcome
}

/** Drovr's cap on one `POST /events/batch`. */
export const DROVR_BATCH_MAX = 100

/** `…/events` becomes `…/events/batch`. */
export function batchIngestUrl(ingestUrl: string): string {
	return `${ingestUrl.replace(/\/+$/, '')}/batch`
}

export class DrovrBatchDeliveryFailedError extends Error {
	constructor(
		readonly failedKeys: readonly string[],
		readonly reason: string,
	) {
		super(
			`drovr batch delivery failed for ${failedKeys.length} event(s): ${reason}`,
		)
		this.name = 'DrovrBatchDeliveryFailedError'
	}
}

export type DrovrBatchOutcome = { accepted: number; rejected: number }

type BatchItemResult = {
	index: number
	status: 'accepted' | 'rejected' | 'failed'
	detail?: string
}

type BatchBody = {
	accepted: number
	rejected: number
	failed: number
	results: BatchItemResult[]
}

function isBatchBody(value: unknown): value is BatchBody {
	if (typeof value !== 'object' || value === null) return false
	const body = value as Record<string, unknown>
	return (
		typeof body.accepted === 'number' &&
		typeof body.rejected === 'number' &&
		typeof body.failed === 'number' &&
		Array.isArray(body.results)
	)
}

/**
 * Up to a hundred events of one tenant through one request, as the step
 * body. Drovr answers per item. `failed` items throw so Inngest retries
 * the whole chunk: replaying the accepted ones is safe, drovr dedupes on
 * the idempotency key and answers `appended: false`. `rejected` items are
 * final and warned once each. A transient envelope answer (5xx, network,
 * timeout) throws too; a 4xx envelope (bad key, bad shape) is final for
 * the chunk, warned and counted as rejected, never retried.
 */
export async function deliverBatchOrThrow(args: {
	events: readonly DrovrShadowEvent[]
	config: DrovrDeliveryConfig
	fetcher?: typeof fetch
	warn?: typeof log.warn
	timeoutMs?: number
}): Promise<DrovrBatchOutcome> {
	const fetcher = args.fetcher ?? fetch
	const warn = args.warn ?? log.warn
	const keys = args.events.map((event) => event.idempotencyKey)
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000)
	try {
		let response: Response
		try {
			response = await fetcher(batchIngestUrl(args.config.ingestUrl), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${args.config.apiKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ events: args.events }),
				signal: controller.signal,
			})
		} catch (error) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				error instanceof Error ? error.message : String(error),
			)
		}
		// A missing route is a drovr that has not deployed the batch ingress
		// yet, not a verdict on the events: retry until it has.
		if (response.status === 404 || response.status === 405) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				`drovr has no batch ingress (${response.status})`,
			)
		}
		if (response.status >= 400 && response.status < 500) {
			await warnSafely(warn, 'drovr.shadow.batch_rejected', {
				status: response.status,
				count: args.events.length,
				tenantId: args.events[0]?.tenantId,
				problem: await boundedProblemBody(response),
			})
			return { accepted: 0, rejected: args.events.length }
		}
		if (response.status !== 200) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				`drovr answered ${response.status}`,
			)
		}
		const body: unknown = await response.json()
		if (!isBatchBody(body)) {
			throw new DrovrBatchDeliveryFailedError(
				keys,
				'drovr answered 200 without a batch body',
			)
		}
		const failedKeys: string[] = []
		for (const item of body.results) {
			const event = args.events[item.index]
			if (item.status === 'failed') {
				if (event) failedKeys.push(event.idempotencyKey)
			} else if (item.status === 'rejected') {
				await warnSafely(warn, 'drovr.shadow.rejected', {
					journeyId: event?.journeyId,
					type: event?.type,
					idempotencyKey: event?.idempotencyKey,
					problem: item.detail,
				})
			}
		}
		if (body.failed > 0) {
			throw new DrovrBatchDeliveryFailedError(
				failedKeys,
				`${body.failed} of ${args.events.length} failed at drovr`,
			)
		}
		return { accepted: body.accepted, rejected: body.rejected }
	} finally {
		clearTimeout(timeout)
	}
}

async function warnSafely(
	warn: typeof log.warn,
	message: string,
	fields: Record<string, unknown>,
): Promise<void> {
	try {
		await warn(message, fields)
	} catch {
		// Logging cannot change the delivery result.
	}
}

/** One step per tenant chunk; the run's event list is fixed, so the index is stable across retries. */
export function batchStepId(tenantId: string, chunkIndex: number): string {
	return `deliver-batch:${tenantId}:${chunkIndex}`
}

/**
 * One step per event, not per idempotency key. Dual-journey facts
 * (purchase, unsubscribe, course exhaustion) reuse one key across two
 * journeys, and Inngest memoizes a completed step by id, so a key-only id
 * would silently skip the second journey's delivery.
 */
export function deliveryStepId(event: DrovrShadowEvent): string {
	return `deliver:${event.journeyId}:${event.idempotencyKey}`
}
