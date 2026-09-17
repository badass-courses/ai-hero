import { log } from '@/server/logger'

import {
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

/**
 * One step per event, not per idempotency key. Dual-journey facts
 * (purchase, unsubscribe, course exhaustion) reuse one key across two
 * journeys, and Inngest memoizes a completed step by id, so a key-only id
 * would silently skip the second journey's delivery.
 */
export function deliveryStepId(event: DrovrShadowEvent): string {
	return `deliver:${event.journeyId}:${event.idempotencyKey}`
}
