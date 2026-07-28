import { valuePathIntentCompletedAt } from './value-path-completion'

/**
 * Honest run-state resolution for the Gate D value-path status surface.
 *
 * Regression context (2026-07): the status surface reported "waiting — no
 * work is due right now" while 90 mid-path participants had computed zero
 * due sends for six weeks (the drip-scan starvation stall). "Running" only
 * means the machinery executes; "moving" means participants actually
 * progress. This module distinguishes the two: a cohort with mid-path
 * participants and no recorded movement inside the stall threshold reads as
 * `stalled`, never as a green `waiting`.
 */

export const DEFAULT_VALUE_PATH_STALL_THRESHOLD_HOURS = 48

const MOVEMENT_EVENT_TYPES = new Set([
	'value-path.entered',
	'value-path.answer-selected',
	'value-path.drip-progressed',
])

const MS_PER_HOUR = 60 * 60 * 1000

export type ValuePathMovement = {
	lastMovementAt?: string
	hoursSinceMovement?: number
	midPathParticipants: number
	stalled: boolean
	stallThresholdHours: number
}

export function evaluateValuePathMovement(args: {
	intents: Array<{
		createdAt: string | Date
		completedAt?: string | Date | null
		metadata?: Record<string, unknown> | null
	}>
	events: Array<{ eventType: string; occurredAt: string | Date }>
	participants: number
	completedPathCount: number
	now: string
	stallThresholdHours?: number
}): ValuePathMovement {
	const stallThresholdHours =
		args.stallThresholdHours ?? DEFAULT_VALUE_PATH_STALL_THRESHOLD_HOURS
	const timestamps: string[] = []
	for (const intent of args.intents) {
		const createdAt = toIso(intent.createdAt)
		if (createdAt) timestamps.push(createdAt)
		const completedAt = valuePathIntentCompletedAt(intent)
		if (completedAt) timestamps.push(completedAt)
	}
	for (const event of args.events) {
		if (!MOVEMENT_EVENT_TYPES.has(event.eventType)) continue
		const occurredAt = toIso(event.occurredAt)
		if (occurredAt) timestamps.push(occurredAt)
	}
	const lastMovementAt = timestamps.length
		? timestamps.reduce((latest, value) => (value > latest ? value : latest))
		: undefined
	const hoursSinceMovement = lastMovementAt
		? Math.max(
				0,
				(new Date(args.now).getTime() - new Date(lastMovementAt).getTime()) /
					MS_PER_HOUR,
			)
		: undefined
	const midPathParticipants = Math.max(
		0,
		args.participants - args.completedPathCount,
	)
	const stalled =
		midPathParticipants > 0 &&
		(hoursSinceMovement === undefined ||
			hoursSinceMovement >= stallThresholdHours)
	return {
		lastMovementAt,
		hoursSinceMovement:
			hoursSinceMovement === undefined
				? undefined
				: Math.round(hoursSinceMovement * 10) / 10,
		midPathParticipants,
		stalled,
		stallThresholdHours,
	}
}

export type GateDRunState = {
	state:
		| 'blocked'
		| 'running'
		| 'retry_waiting'
		| 'completed'
		| 'stalled'
		| 'waiting'
	plainLanguage: string
}

export function resolveGateDRunState(args: {
	authorizationPassed: boolean
	authorizationReviewReasons: readonly string[]
	hardBlockerCount: number
	retryableDue: number
	retryableWaiting: number
	nextRetryAt?: string
	pending: number
	dueSends: number
	participants: number
	completedPathCount: number
	movement: ValuePathMovement
}): GateDRunState {
	if (!args.authorizationPassed) {
		return {
			state: 'blocked',
			plainLanguage: `Authorization is blocked: ${args.authorizationReviewReasons.join(', ')}`,
		}
	}
	if (args.hardBlockerCount > 0) {
		return {
			state: 'blocked',
			plainLanguage: 'Hard blockers need operator action.',
		}
	}
	if (args.retryableDue > 0) {
		return { state: 'running', plainLanguage: 'Retryable sends are due now.' }
	}
	if (args.pending > 0 || args.dueSends > 0) {
		return { state: 'running', plainLanguage: 'Authorized sends are due now.' }
	}
	if (args.retryableWaiting > 0) {
		return {
			state: 'retry_waiting',
			plainLanguage: `Waiting for Kit retry until ${args.nextRetryAt}.`,
		}
	}
	if (
		args.participants > 0 &&
		args.completedPathCount === args.participants
	) {
		return {
			state: 'completed',
			plainLanguage: 'All participants reached a terminal path email.',
		}
	}
	if (args.movement.stalled) {
		return {
			state: 'stalled',
			plainLanguage: `STALLED: ${args.movement.midPathParticipants} participants are mid-path, no sends are computed as due, and nothing has moved since ${args.movement.lastMovementAt ?? 'activation'} (threshold ${args.movement.stallThresholdHours}h). Operator action needed.`,
		}
	}
	return {
		state: 'waiting',
		plainLanguage: 'Authorization is active and no work is due right now.',
	}
}

function toIso(value: string | Date | undefined | null) {
	if (!value) return undefined
	const date = value instanceof Date ? value : new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
