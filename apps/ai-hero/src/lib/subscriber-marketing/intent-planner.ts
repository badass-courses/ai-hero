import type {
	ContactEventRecord,
	ContactState,
	NextAction,
	SideEffectIntent,
} from './types'

export function planDryRunIntents(args: {
	state: ContactState
	event: ContactEventRecord
	now: string
	nextActionId: string
	intentId: string
}): { nextAction: NextAction; sideEffectIntents: SideEffectIntent[] } {
	return planGatedIntents({
		...args,
		gate: {
			slug: 'gate-a-dry-run',
			passed: true,
			reason: 'Gate A allows inspection-only dry-run planning.',
		},
		customerVisibleReason:
			'Customer-visible side effects are blocked in Gate A.',
		intentIdempotencyPrefix: 'gate-a',
	})
}

export function planInternalCaptureIntents(args: {
	state: ContactState
	event: ContactEventRecord
	now: string
	nextActionId: string
	intentId: string
}): { nextAction: NextAction; sideEffectIntents: SideEffectIntent[] } {
	return planGatedIntents({
		...args,
		gate: {
			slug: 'gate-b-internal-capture',
			passed: true,
			reason: 'Gate B allows internal capture and operator inspection only.',
		},
		customerVisibleReason:
			'Customer-visible side effects are blocked in Gate B.',
		intentIdempotencyPrefix: 'gate-b',
	})
}

function planGatedIntents(args: {
	state: ContactState
	event: ContactEventRecord
	now: string
	nextActionId: string
	intentId: string
	gate: {
		slug: 'gate-a-dry-run' | 'gate-b-internal-capture'
		passed: true
		reason: string
	}
	customerVisibleReason: string
	intentIdempotencyPrefix: string
}): { nextAction: NextAction; sideEffectIntents: SideEffectIntent[] } {
	const gates = [
		args.gate,
		{
			slug: 'human-review' as const,
			passed: !args.state.humanReview,
			reason: args.state.humanReview
				? 'Human Review Flag is a hard stop.'
				: 'No review signals detected.',
		},
		{
			slug: 'customer-visible-side-effects' as const,
			passed: false,
			reason: args.customerVisibleReason,
		},
	]
	const reviewReasons = args.state.humanReview ? args.state.reviewSignals : []
	const type = args.state.humanReview ? 'human-review' : 'enter-value-path'
	const status = args.state.humanReview ? 'blocked' : 'planned'
	const nextAction: NextAction = {
		id: args.nextActionId,
		contactId: args.event.contactId,
		contactStateId: args.state.id,
		eventId: args.event.id,
		type,
		status,
		gates,
		reviewReasons,
		rationale: [
			`Primary bucket ${args.state.primaryBucket} can be inspected, not executed.`,
		],
		createdAt: args.now,
	}
	const blocked = args.state.humanReview
	const sideEffectIntents: SideEffectIntent[] = [
		{
			id: args.intentId,
			nextActionId: nextAction.id,
			contactId: args.event.contactId,
			provider: 'dry-run',
			type: blocked ? 'human-review' : 'preview-shadow-field-sync',
			status: blocked ? 'blocked' : 'dry-run',
			idempotencyKey: `${args.intentIdempotencyPrefix}:${args.event.semanticIdempotencyKey}:${type}`,
			gates,
			reviewReasons,
			metadata: {
				primaryBucket: args.state.primaryBucket,
				allBuckets: args.state.allBuckets,
			},
			createdAt: args.now,
		},
	]
	return { nextAction, sideEffectIntents }
}
