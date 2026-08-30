import {
	addPitchMessagePlan,
	buildBridgeMessagePlan,
	couponExpiresAtForOpening,
} from './calendar'
import type {
	ActiveJourneyAggregate,
	DecideEvergreenOfferJourneyInput,
	DeliverySettled,
	EligibilityDecision,
	EvergreenOfferJourneyAggregate,
	FinalJourneyAggregate,
	JourneyDecision,
	JourneyDecisionError,
	JourneyDecisionResult,
	JourneyDomainEvent,
	JourneyExit,
	JourneyPhase,
	MessageSlot,
	ScheduleWakeIntent,
	SideEffectIntent,
} from './domain'
import { EVERGREEN_OFFER_JOURNEY_SCHEMA_VERSION } from './domain'
import { decideEvergreenOfferEligibility } from './eligibility'
import { transitionJourneyPhase, type JourneyPhaseEvent } from './phase-machine'
import {
	couponBindingIntentKey,
	couponIntentKey,
	deriveJourneyId,
	messageIntentKey,
	scheduleWakeId,
	shadowIntentKey,
	type IntentKey,
	type IsoInstant,
} from './primitives'

export function decideEvergreenOfferJourney(
	input: DecideEvergreenOfferJourneyInput,
): JourneyDecisionResult {
	if (!input.snapshot) {
		const definitionError = validateDefinition(input.definition)
		return definitionError
			? decisionError('InvariantViolation', definitionError)
			: startJourney(input)
	}
	const pinnedDefinitionError = validateDefinition(input.snapshot.definition)
	if (pinnedDefinitionError) {
		return decisionError('InvariantViolation', pinnedDefinitionError)
	}
	if (input.stimulus.type === 'CourseSequenceExhausted') {
		return ignored('JourneyAlreadyStarted', input.snapshot)
	}
	if (input.stimulus.journeyId !== input.snapshot.journeyId) {
		return ignored('StimulusForAnotherJourney', input.snapshot)
	}
	if (input.currentFacts.contactId !== input.snapshot.contactId) {
		return decisionError(
			'InvariantViolation',
			'Current authority belongs to another contact',
		)
	}
	if (
		input.snapshot.messagePlan.definitionVersion !==
			input.snapshot.definition.definitionVersion ||
		input.snapshot.messagePlan.messagePlanSourceHash !==
			input.snapshot.definition.messagePlanSourceHash
	) {
		return decisionError(
			'InvariantViolation',
			'Runtime definition does not match the journey pinned at entry',
		)
	}
	if (isFinal(input.snapshot)) return ignored('JourneyFinal', input.snapshot)
	const activeInput: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	} = {
		...input,
		definition: input.snapshot.definition,
		snapshot: input.snapshot,
	}

	const hardStop = hardStopFromInput(activeInput)
	if (hardStop) return hardStop

	switch (input.stimulus.type) {
		case 'WakeDue':
			return handleWake(activeInput)
		case 'DeliverySettled':
			return handleDeliverySettled(activeInput, input.stimulus)
		case 'CouponIssued':
			return handleCouponIssued(activeInput)
		case 'VerifiedUserObserved':
			return handleVerifiedUserObserved(activeInput)
		case 'CouponBoundToUser':
			return handleCouponBound(activeInput)
		case 'ShadowNewsletterEntered':
			return handleShadowEntered(activeInput)
		case 'PermanentEffectRefusal':
			return handlePermanentRefusal(activeInput)
		case 'PurchaseObserved':
		case 'UnsubscribeObserved':
		case 'SuppressionObserved':
		case 'OperatorStopObserved':
			return decisionError(
				'InvariantViolation',
				'Hard-stop stimulus was not consumed by the hard-stop policy',
			)
		default: {
			const unreachable: never = input.stimulus
			return unreachable
		}
	}
}

function startJourney(
	input: DecideEvergreenOfferJourneyInput,
): JourneyDecisionResult {
	if (input.stimulus.type !== 'CourseSequenceExhausted') {
		return ignored('UnexpectedStimulusForPhase', null)
	}
	if (input.currentFacts.contactId !== input.stimulus.contactId) {
		return decisionError(
			'InvariantViolation',
			'Current authority belongs to another entry contact',
		)
	}
	const eligibility = decideEvergreenOfferEligibility(input.currentFacts)
	if (eligibility.type === 'Ineligible') {
		return {
			ok: true,
			decision: {
				type: 'Ignored',
				reason: 'EntryIneligible',
				current: null,
				eligibility,
			},
		}
	}
	const phase = requirePhase('not_started', { type: 'START' })
	if (!phase.ok) return phase
	const scheduled = buildBridgeMessagePlan({
		exhaustedAt: input.stimulus.exhaustedAt,
		deadlineTimeZone: input.stimulus.deadlineTimeZone,
		definition: input.definition,
	})
	if (!scheduled.ok) {
		return decisionError('ScheduleInvalid', scheduled.error.detail)
	}
	const journeyId = deriveJourneyId(input.stimulus.entryFactId)
	const next: ActiveJourneyAggregate = {
		schemaVersion: EVERGREEN_OFFER_JOURNEY_SCHEMA_VERSION,
		journeyId,
		entryFactId: input.stimulus.entryFactId,
		contactId: input.stimulus.contactId,
		valuePathId: input.stimulus.valuePathId,
		exhaustedAt: input.stimulus.exhaustedAt,
		deadlineTimeZone: input.stimulus.deadlineTimeZone,
		definition: input.definition,
		messagePlan: scheduled.value.messagePlan,
		version: 1,
		phase: 'bridge.running',
		coupon: null,
	}
	const wakeIntents = [
		...next.messagePlan.bridge.map((slot) => messageWake(next, slot)),
		couponWake(next, scheduled.value.couponIssueAt),
	]
	return accepted({
		input,
		from: 'not_started',
		next,
		events: [event('JourneyStarted', input.now, { journeyId })],
		wakeIntents,
	})
}

function handleWake(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult {
	const stimulus = input.stimulus
	if (stimulus.type !== 'WakeDue') {
		return ignored('UnexpectedStimulusForPhase', input.snapshot)
	}
	const expired = markExpiredSlots(input.snapshot.messagePlan, input.now)
	const current = { ...input.snapshot, messagePlan: expired.messagePlan }
	if (stimulus.purpose.type === 'MessageSlot') {
		const slotId = stimulus.purpose.slotId
		const slot = allSlots(current).find(
			(candidate) => candidate.slotId === slotId,
		)
		if (!slot) return ignored('UnknownSlot', input.snapshot)
		const expectedWakeId = scheduleWakeId({
			journeyId: current.journeyId,
			semanticStepId: `message:${slot.slotId}`,
		})
		if (stimulus.wakeId !== expectedWakeId || stimulus.dueAt !== slot.dueAt) {
			return decisionError(
				'InvariantViolation',
				'Message wake does not match the committed slot schedule',
			)
		}
		if (expired.events.length > 0 && slot.status !== 'Scheduled') {
			return accepted({
				input,
				from: input.snapshot.phase,
				next: incrementVersion(current),
				events: expired.events,
			})
		}
		if (slot.status === 'IntentCommitted') {
			return ignored('SlotIntentAlreadyCommitted', current)
		}
		if (slot.status !== 'Scheduled') {
			return ignored('SlotAlreadySettled', current)
		}
		if (
			Date.parse(input.now) < Date.parse(slot.dueAt) ||
			Date.parse(input.now) >= Date.parse(slot.windowEndsAt)
		) {
			return ignored('SlotNotOpen', current)
		}
		const idempotencyKey = messageIntentKey({
			journeyId: current.journeyId,
			contentResourceId: slot.contentResourceId,
		})
		const committed: MessageSlot = {
			...slot,
			status: 'IntentCommitted',
			intentKey: idempotencyKey,
			committedAt: input.now,
		}
		const next = withMessageSlot(current, committed)
		return accepted({
			input,
			from: input.snapshot.phase,
			next: incrementVersion(next),
			events: [
				...expired.events,
				event('MessageIntentCommitted', input.now, {
					slotId: slot.slotId,
					idempotencyKey,
				}),
			],
			sideEffectIntents: [
				{
					type: 'SendMessage',
					idempotencyKey,
					journeyId: current.journeyId,
					contactId: current.contactId,
					slotId: slot.slotId,
					contentResourceId: slot.contentResourceId,
					presentation: slot.presentation,
					notBefore: slot.dueAt,
					notAfter: slot.windowEndsAt,
					couponId: current.coupon?.couponId ?? null,
				},
			],
		})
	}
	if (stimulus.purpose.type === 'CouponIssue') {
		if (
			current.phase !== 'bridge.running' &&
			current.phase !== 'coupon.waiting'
		) {
			return ignored('UnexpectedStimulusForPhase', current)
		}
		const expectedWakeId = scheduleWakeId({
			journeyId: current.journeyId,
			semanticStepId: 'coupon.issue',
		})
		if (
			stimulus.wakeId !== expectedWakeId ||
			stimulus.dueAt !== current.messagePlan.bridge[2].windowEndsAt
		) {
			return decisionError(
				'InvariantViolation',
				'Coupon wake does not match the committed bridge schedule',
			)
		}
		if (Date.parse(input.now) < Date.parse(stimulus.dueAt)) {
			return ignored('SlotNotOpen', current)
		}
		const phase = requirePhase(current.phase, { type: 'COUPON_WAKE' })
		if (!phase.ok) return phase
		const issueAt = stimulus.dueAt
		const expiresAt = couponExpiresAtForOpening({
			openingAt: issueAt,
			timeZone: current.deadlineTimeZone.timeZone,
		})
		if (Date.parse(input.now) >= Date.parse(expiresAt)) {
			const stoppedPhase = requirePhase(current.phase, { type: 'STOP' })
			if (!stoppedPhase.ok) return stoppedPhase
			const exit: JourneyExit = {
				type: 'PermanentFailure',
				observedAt: input.now,
				reason: 'Coupon issue window expired before application',
			}
			return accepted({
				input,
				from: input.snapshot.phase,
				next: {
					...current,
					phase: 'stopped',
					coupon: null,
					exit,
					version: current.version + 1,
				},
				events: [
					...expired.events,
					event('JourneyExited', input.now, { reason: exit.type }),
				],
			})
		}
		const idempotencyKey = couponIntentKey(current.journeyId)
		const next: ActiveJourneyAggregate = {
			...current,
			phase: 'coupon.awaitingReceipt',
			coupon: null,
			version: current.version + 1,
		}
		return accepted({
			input,
			from: input.snapshot.phase,
			next,
			events: [
				...expired.events,
				event('CouponIntentCommitted', input.now, { idempotencyKey }),
			],
			sideEffectIntents: [
				{
					type: 'IssueCoupon',
					idempotencyKey,
					journeyId: current.journeyId,
					contactId: current.contactId,
					issueAt,
					expiresAt,
					terms: input.definition.couponTerms,
					deadlineTimeZone: current.deadlineTimeZone,
				},
			],
		})
	}
	if (current.phase !== 'pitch.running' || !current.coupon) {
		return ignored('UnexpectedStimulusForPhase', current)
	}
	const expectedWakeId = scheduleWakeId({
		journeyId: current.journeyId,
		semanticStepId: 'coupon.expiry',
	})
	if (
		stimulus.wakeId !== expectedWakeId ||
		stimulus.dueAt !== current.coupon.expiresAt
	) {
		return decisionError(
			'InvariantViolation',
			'Coupon expiry wake does not match coupon authority',
		)
	}
	if (Date.parse(input.now) < Date.parse(current.coupon.expiresAt)) {
		return ignored('SlotNotOpen', current)
	}
	const phase = requirePhase(current.phase, { type: 'COUPON_EXPIRED' })
	if (!phase.ok) return phase
	const idempotencyKey = shadowIntentKey(current.journeyId)
	const next: ActiveJourneyAggregate = {
		...current,
		phase: 'handoff.awaitingReceipt',
		coupon: current.coupon,
		version: current.version + 1,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [
			...expired.events,
			event('HandoffIntentCommitted', input.now, { idempotencyKey }),
		],
		sideEffectIntents: [
			{
				type: 'EnterShadowNewsletter',
				idempotencyKey,
				journeyId: current.journeyId,
				contactId: current.contactId,
			},
		],
	})
}

function handleDeliverySettled(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
	stimulus: DeliverySettled,
): JourneyDecisionResult {
	const slot = allSlots(input.snapshot).find(
		(candidate) => candidate.slotId === stimulus.slotId,
	)
	if (!slot) return ignored('UnknownSlot', input.snapshot)
	if (
		slot.status !== 'IntentCommitted' &&
		!(slot.status === 'Missed' && slot.intentKey)
	) {
		return ignored('SlotAlreadySettled', input.snapshot)
	}
	if (slot.intentKey !== stimulus.intentKey) {
		return decisionError(
			'InvariantViolation',
			'Delivery receipt intent key does not match the committed slot intent',
		)
	}
	const settled = settledSlot(slot, stimulus)
	let next = withMessageSlot(input.snapshot, settled)
	if (stimulus.outcome.type === 'ContactUndeliverable') {
		const phase = requirePhase(input.snapshot.phase, { type: 'STOP' })
		if (!phase.ok) return phase
		const exit: JourneyExit = {
			type: 'PermanentFailure',
			observedAt: stimulus.settledAt,
			reason: stimulus.outcome.reason,
		}
		return accepted({
			input,
			from: input.snapshot.phase,
			next: {
				...next,
				phase: 'stopped',
				coupon: next.coupon,
				exit,
				version: next.version + 1,
			},
			events: [
				event('MessageSettled', input.now, {
					slotId: slot.slotId,
					intentKey: stimulus.intentKey,
					outcome: stimulus.outcome.type,
				}),
				event('JourneyExited', input.now, { reason: exit.type }),
			],
		})
	}
	let phaseEvent: JourneyPhaseEvent | undefined
	if (
		slot.phase === 'Bridge' &&
		slot.slotId === input.snapshot.messagePlan.bridge[2].slotId &&
		input.snapshot.phase === 'bridge.running'
	) {
		phaseEvent = { type: 'BRIDGE_SLOTS_FINISHED' }
	}
	if (phaseEvent) {
		const phase = requirePhase(input.snapshot.phase, phaseEvent)
		if (!phase.ok) return phase
		next = { ...next, phase: 'coupon.waiting', coupon: null }
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next: incrementVersion(next),
		events: [
			event('MessageSettled', input.now, {
				slotId: slot.slotId,
				intentKey: stimulus.intentKey,
				outcome: stimulus.outcome.type,
			}),
		],
	})
}

function handleCouponIssued(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult {
	const stimulus = input.stimulus
	if (
		stimulus.type !== 'CouponIssued' ||
		input.snapshot.phase !== 'coupon.awaitingReceipt'
	) {
		return ignored('UnexpectedStimulusForPhase', input.snapshot)
	}
	if (
		stimulus.coupon.contactId !== input.snapshot.contactId ||
		stimulus.intentKey !== couponIntentKey(input.snapshot.journeyId)
	) {
		return decisionError(
			'InvariantViolation',
			'Coupon receipt does not match the journey owner or semantic intent',
		)
	}
	if (
		stimulus.coupon.issuedAt !==
			input.snapshot.messagePlan.bridge[2].windowEndsAt ||
		stimulus.coupon.deadlineTimeZone.timeZone !==
			input.snapshot.deadlineTimeZone.timeZone
	) {
		return decisionError(
			'InvariantViolation',
			'Coupon receipt does not match the committed opening or time zone',
		)
	}
	if (stimulus.coupon.binding.type !== 'AwaitingVerifiedUser') {
		return decisionError(
			'InvariantViolation',
			'Coupon must enter the journey before verified-user binding',
		)
	}
	if (
		stimulus.coupon.terms.productId !== input.definition.couponTerms.productId ||
		stimulus.coupon.terms.amountOffCents !==
			input.definition.couponTerms.amountOffCents ||
		stimulus.coupon.terms.currency !== input.definition.couponTerms.currency ||
		stimulus.coupon.terms.maxUses !== input.definition.couponTerms.maxUses ||
		stimulus.coupon.terms.exclusive !== input.definition.couponTerms.exclusive
	) {
		return decisionError(
			'InvariantViolation',
			'Coupon receipt terms do not match the pinned journey definition',
		)
	}
	const messagePlan = addPitchMessagePlan({
		messagePlan: input.snapshot.messagePlan,
		coupon: stimulus.coupon,
		definition: input.definition,
	})
	if (!messagePlan.ok) {
		return decisionError('ScheduleInvalid', messagePlan.error.detail)
	}
	const phase = requirePhase(input.snapshot.phase, { type: 'COUPON_ISSUED' })
	if (!phase.ok) return phase
	const next: ActiveJourneyAggregate = {
		...input.snapshot,
		phase: 'pitch.running',
		coupon: stimulus.coupon,
		messagePlan: messagePlan.value,
		version: input.snapshot.version + 1,
	}
	const wakeIntents = [
		...next.messagePlan.pitch.map((slot) => messageWake(next, slot)),
		expiryWake(next),
	]
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [
			event('CouponRecorded', input.now, {
				couponId: stimulus.coupon.couponId,
				expiresAt: stimulus.coupon.expiresAt,
			}),
		],
		wakeIntents,
	})
}

function handleVerifiedUserObserved(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult {
	const stimulus = input.stimulus
	if (
		stimulus.type !== 'VerifiedUserObserved' ||
		(input.snapshot.phase !== 'pitch.running' &&
			input.snapshot.phase !== 'handoff.awaitingReceipt') ||
		!input.snapshot.coupon
	) {
		return ignored('UnexpectedStimulusForPhase', input.snapshot)
	}
	const binding = input.snapshot.coupon.binding
	if (binding.type === 'BoundToVerifiedUser') {
		return binding.verifiedUserId === stimulus.verifiedUserId
			? ignored('CouponAlreadyBound', input.snapshot)
			: decisionError(
					'InvariantViolation',
					'Coupon is already bound to another verified user',
				)
	}
	if (binding.type === 'BindingIntentCommitted') {
		return binding.verifiedUserId === stimulus.verifiedUserId
			? ignored('CouponBindingIntentAlreadyCommitted', input.snapshot)
			: decisionError(
					'InvariantViolation',
					'Coupon binding is already committed for another verified user',
				)
	}
	const idempotencyKey = couponBindingIntentKey({
		journeyId: input.snapshot.journeyId,
		verifiedUserId: stimulus.verifiedUserId,
	})
	const next: ActiveJourneyAggregate = {
		...input.snapshot,
		coupon: {
			...input.snapshot.coupon,
			binding: {
				type: 'BindingIntentCommitted',
				verifiedUserId: stimulus.verifiedUserId,
				intentKey: idempotencyKey,
				committedAt: input.now,
			},
		},
		version: input.snapshot.version + 1,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [
			event('CouponBindingIntentCommitted', input.now, {
				couponId: input.snapshot.coupon.couponId,
				verifiedUserId: stimulus.verifiedUserId,
				intentKey: idempotencyKey,
			}),
		],
		sideEffectIntents: [
			{
				type: 'BindCoupon',
				idempotencyKey,
				journeyId: input.snapshot.journeyId,
				couponId: input.snapshot.coupon.couponId,
				contactId: input.snapshot.contactId,
				verifiedUserId: stimulus.verifiedUserId,
			},
		],
	})
}

function handleCouponBound(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult {
	const stimulus = input.stimulus
	if (
		stimulus.type !== 'CouponBoundToUser' ||
		(input.snapshot.phase !== 'pitch.running' &&
			input.snapshot.phase !== 'handoff.awaitingReceipt') ||
		!input.snapshot.coupon
	) {
		return ignored('UnexpectedStimulusForPhase', input.snapshot)
	}
	if (stimulus.couponId !== input.snapshot.coupon.couponId) {
		return decisionError(
			'InvariantViolation',
			'Coupon binding receipt belongs to another coupon',
		)
	}
	const binding = input.snapshot.coupon.binding
	if (binding.type === 'AwaitingVerifiedUser') {
		return decisionError(
			'InvariantViolation',
			'Coupon binding receipt arrived before its intent was committed',
		)
	}
	if (binding.type === 'BoundToVerifiedUser') {
		return binding.verifiedUserId === stimulus.verifiedUserId
			? ignored('CouponAlreadyBound', input.snapshot)
			: decisionError(
					'InvariantViolation',
					'Coupon is already bound to another verified user',
				)
	}
	if (binding.verifiedUserId !== stimulus.verifiedUserId) {
		return decisionError(
			'InvariantViolation',
			'Coupon binding receipt belongs to another verified user',
		)
	}
	const expectedIntentKey = binding.intentKey
	if (stimulus.intentKey !== expectedIntentKey) {
		return decisionError(
			'InvariantViolation',
			'Coupon binding receipt does not match its semantic intent',
		)
	}
	const next: ActiveJourneyAggregate = {
		...input.snapshot,
		coupon: {
			...input.snapshot.coupon,
			binding: {
				type: 'BoundToVerifiedUser',
				verifiedUserId: stimulus.verifiedUserId,
				boundAt: stimulus.boundAt,
			},
		},
		version: input.snapshot.version + 1,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [
			event('CouponBindingRecorded', input.now, {
				couponId: stimulus.couponId,
				bindingIntentKey: expectedIntentKey,
			}),
		],
	})
}

function handleShadowEntered(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult {
	const stimulus = input.stimulus
	if (
		stimulus.type !== 'ShadowNewsletterEntered' ||
		input.snapshot.phase !== 'handoff.awaitingReceipt' ||
		!input.snapshot.coupon
	) {
		return ignored('UnexpectedStimulusForPhase', input.snapshot)
	}
	if (stimulus.intentKey !== shadowIntentKey(input.snapshot.journeyId)) {
		return decisionError(
			'InvariantViolation',
			'Shadow Newsletter receipt does not match the journey intent',
		)
	}
	const phase = requirePhase(input.snapshot.phase, { type: 'SHADOW_ENTERED' })
	if (!phase.ok) return phase
	const exit: JourneyExit = {
		type: 'EnteredShadowNewsletter',
		enteredAt: stimulus.enteredAt,
	}
	const next: EvergreenOfferJourneyAggregate = {
		...input.snapshot,
		phase: 'complete',
		coupon: input.snapshot.coupon,
		exit,
		version: input.snapshot.version + 1,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [event('JourneyExited', input.now, { reason: exit.type })],
	})
}

function handlePermanentRefusal(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult {
	const stimulus = input.stimulus
	if (stimulus.type !== 'PermanentEffectRefusal') {
		return ignored('UnexpectedStimulusForPhase', input.snapshot)
	}
	if (stimulus.scope === 'Contact') {
		if (!contactRefusalMatchesCommittedIntent(input.snapshot, stimulus.intentKey)) {
			return decisionError(
				'InvariantViolation',
				'Contact refusal does not match a committed journey intent',
			)
		}
		return stopJourney(input, {
			type: 'PermanentFailure',
			observedAt: stimulus.observedAt,
			reason: stimulus.reason,
		})
	}
	const slot = allSlots(input.snapshot).find(
		(candidate) => candidate.slotId === stimulus.slotId,
	)
	if (!slot) return ignored('UnknownSlot', input.snapshot)
	if (slot.status !== 'IntentCommitted') {
		return ignored('SlotAlreadySettled', input.snapshot)
	}
	if (slot.intentKey !== stimulus.intentKey) {
		return decisionError(
			'InvariantViolation',
			'Message refusal intent key does not match the committed slot intent',
		)
	}
	const refused: MessageSlot = {
		...messageSlotBase(slot),
		status: 'Refused',
		intentKey: stimulus.intentKey,
		settledAt: stimulus.observedAt,
		reason: stimulus.reason,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next: incrementVersion(withMessageSlot(input.snapshot, refused)),
		events: [
			event('MessageSettled', input.now, {
				slotId: stimulus.slotId,
				intentKey: stimulus.intentKey,
				outcome: 'MessageRefused',
			}),
		],
	})
}

function hardStopFromInput(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
): JourneyDecisionResult | undefined {
	const stimulus = input.stimulus
	if (stimulus.type === 'PurchaseObserved') {
		return customerJourney(input, stimulus.purchase)
	}
	if (stimulus.type === 'UnsubscribeObserved') {
		return stopJourney(input, {
			type: 'Unsubscribed',
			observedAt: stimulus.observedAt,
		})
	}
	if (stimulus.type === 'SuppressionObserved') {
		return stopJourney(input, {
			type: 'Suppressed',
			observedAt: stimulus.observedAt,
			reason: stimulus.reason,
		})
	}
	if (stimulus.type === 'OperatorStopObserved') {
		return stopJourney(input, {
			type: 'OperatorStopped',
			observedAt: stimulus.observedAt,
			reason: stimulus.reason,
		})
	}
	if (input.currentFacts.purchase) {
		return customerJourney(input, input.currentFacts.purchase)
	}
	if (input.currentFacts.delivery.type !== 'Eligible') {
		switch (input.currentFacts.delivery.type) {
			case 'Unsubscribed':
				return stopJourney(input, {
					type: 'Unsubscribed',
					observedAt: input.now,
				})
			case 'Suppressed':
				return stopJourney(input, {
					type: 'Suppressed',
					observedAt: input.now,
					reason: input.currentFacts.delivery.evidence,
				})
			case 'Undeliverable':
				return stopJourney(input, {
					type: 'PermanentFailure',
					observedAt: input.now,
					reason: input.currentFacts.delivery.evidence,
				})
			default: {
				const unreachable: never = input.currentFacts.delivery
				return unreachable
			}
		}
	}
	if (
		input.currentFacts.automationControl.type === 'Stopped' &&
		(stimulus.type === 'WakeDue' || stimulus.type === 'VerifiedUserObserved')
	) {
		return {
			ok: true,
			decision: {
				type: 'Ignored',
				reason: 'AutomationHalted',
				current: input.snapshot,
			},
		}
	}
	return undefined
}

function contactRefusalMatchesCommittedIntent(
	aggregate: ActiveJourneyAggregate,
	intentKey: IntentKey,
) {
	if (
		aggregate.phase === 'coupon.awaitingReceipt' &&
		intentKey === couponIntentKey(aggregate.journeyId)
	) {
		return true
	}
	if (
		aggregate.phase === 'handoff.awaitingReceipt' &&
		intentKey === shadowIntentKey(aggregate.journeyId)
	) {
		return true
	}
	if (
		aggregate.coupon?.binding.type === 'BindingIntentCommitted' &&
		aggregate.coupon.binding.intentKey === intentKey
	) {
		return true
	}
	return allSlots(aggregate).some(
		(slot) =>
			slot.status === 'IntentCommitted' && slot.intentKey === intentKey,
	)
}

function customerJourney(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
	purchase: Extract<JourneyExit, { type: 'Purchased' }>['purchase'],
): JourneyDecisionResult {
	const phase = requirePhase(input.snapshot.phase, { type: 'PURCHASE' })
	if (!phase.ok) return phase
	const exit: Extract<JourneyExit, { type: 'Purchased' }> = {
		type: 'Purchased',
		purchase,
	}
	const next: EvergreenOfferJourneyAggregate = {
		...input.snapshot,
		phase: 'customer',
		coupon: input.snapshot.coupon,
		exit,
		version: input.snapshot.version + 1,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [event('JourneyExited', input.now, { reason: exit.type })],
	})
}

function stopJourney(
	input: DecideEvergreenOfferJourneyInput & {
		snapshot: ActiveJourneyAggregate
	},
	exit: Extract<
		JourneyExit,
		{
			type:
				| 'Unsubscribed'
				| 'Suppressed'
				| 'OperatorStopped'
				| 'PermanentFailure'
		}
	>,
): JourneyDecisionResult {
	const phase = requirePhase(input.snapshot.phase, { type: 'STOP' })
	if (!phase.ok) return phase
	const next: EvergreenOfferJourneyAggregate = {
		...input.snapshot,
		phase: 'stopped',
		coupon: input.snapshot.coupon,
		exit,
		version: input.snapshot.version + 1,
	}
	return accepted({
		input,
		from: input.snapshot.phase,
		next,
		events: [event('JourneyExited', input.now, { reason: exit.type })],
	})
}

type MessageSlotBaseFields = Pick<
	MessageSlot,
	| 'slotId'
	| 'contentResourceId'
	| 'presentation'
	| 'phase'
	| 'dueAt'
	| 'windowEndsAt'
>

function messageSlotBase(slot: MessageSlot): MessageSlotBaseFields {
	return {
		slotId: slot.slotId,
		contentResourceId: slot.contentResourceId,
		presentation: slot.presentation,
		phase: slot.phase,
		dueAt: slot.dueAt,
		windowEndsAt: slot.windowEndsAt,
	}
}

function settledSlot(slot: MessageSlot, stimulus: DeliverySettled): MessageSlot {
	switch (stimulus.outcome.type) {
		case 'Applied':
			return {
				...messageSlotBase(slot),
				status: 'Applied',
				intentKey: stimulus.intentKey,
				settledAt: stimulus.settledAt,
				providerReceiptId: stimulus.outcome.providerReceiptId,
			}
		case 'MessageRefused':
		case 'ContactUndeliverable':
			return {
				...messageSlotBase(slot),
				status: 'Refused',
				intentKey: stimulus.intentKey,
				settledAt: stimulus.settledAt,
				reason: stimulus.outcome.reason,
			}
		case 'Ambiguous':
			return {
				...messageSlotBase(slot),
				status: 'Ambiguous',
				intentKey: stimulus.intentKey,
				settledAt: stimulus.settledAt,
				reason: stimulus.outcome.reason,
			}
		default: {
			const unreachable: never = stimulus.outcome
			return unreachable
		}
	}
}

type ExpiredSlotsResult = {
	readonly messagePlan: ActiveJourneyAggregate['messagePlan']
	readonly events: JourneyDomainEvent[]
}

function markExpiredSlots(
	messagePlan: ActiveJourneyAggregate['messagePlan'],
	now: IsoInstant,
): ExpiredSlotsResult {
	const events: JourneyDomainEvent[] = []
	const expire = (slot: MessageSlot): MessageSlot => {
		if (
			(slot.status === 'Scheduled' || slot.status === 'IntentCommitted') &&
			Date.parse(now) >= Date.parse(slot.windowEndsAt)
		) {
			events.push(
				event('MessageMissed', now, {
					slotId: slot.slotId,
					intentKey:
						slot.status === 'IntentCommitted' ? slot.intentKey : null,
				}),
			)
			return {
				...messageSlotBase(slot),
				status: 'Missed',
				intentKey:
					slot.status === 'IntentCommitted' ? slot.intentKey : null,
				missedAt: now,
				reason: 'DeliveryWindowClosed',
			}
		}
		return slot
	}
	return {
		messagePlan: {
			...messagePlan,
			bridge: [
				expire(messagePlan.bridge[0]),
				expire(messagePlan.bridge[1]),
				expire(messagePlan.bridge[2]),
			],
			pitch: messagePlan.pitch.map(expire),
		},
		events,
	}
}

function withMessageSlot(
	aggregate: ActiveJourneyAggregate,
	replacement: MessageSlot,
): ActiveJourneyAggregate {
	return {
		...aggregate,
		messagePlan: {
			...aggregate.messagePlan,
			bridge: [
				aggregate.messagePlan.bridge[0].slotId === replacement.slotId
					? replacement
					: aggregate.messagePlan.bridge[0],
				aggregate.messagePlan.bridge[1].slotId === replacement.slotId
					? replacement
					: aggregate.messagePlan.bridge[1],
				aggregate.messagePlan.bridge[2].slotId === replacement.slotId
					? replacement
					: aggregate.messagePlan.bridge[2],
			],
			pitch: aggregate.messagePlan.pitch.map((slot) =>
				slot.slotId === replacement.slotId ? replacement : slot,
			),
		},
	}
}

function incrementVersion(
	aggregate: ActiveJourneyAggregate,
): ActiveJourneyAggregate {
	return { ...aggregate, version: aggregate.version + 1 }
}

function allSlots(aggregate: ActiveJourneyAggregate) {
	return [...aggregate.messagePlan.bridge, ...aggregate.messagePlan.pitch]
}

function messageWake(
	aggregate: ActiveJourneyAggregate,
	slot: MessageSlot,
): ScheduleWakeIntent {
	return {
		type: 'ScheduleWake',
		wakeId: scheduleWakeId({
			journeyId: aggregate.journeyId,
			semanticStepId: `message:${slot.slotId}`,
		}),
		journeyId: aggregate.journeyId,
		dueAt: slot.dueAt,
		purpose: { type: 'MessageSlot', slotId: slot.slotId },
	}
}

function couponWake(
	aggregate: ActiveJourneyAggregate,
	dueAt: IsoInstant,
): ScheduleWakeIntent {
	return {
		type: 'ScheduleWake',
		wakeId: scheduleWakeId({
			journeyId: aggregate.journeyId,
			semanticStepId: 'coupon.issue',
		}),
		journeyId: aggregate.journeyId,
		dueAt,
		purpose: { type: 'CouponIssue' },
	}
}

function expiryWake(aggregate: ActiveJourneyAggregate): ScheduleWakeIntent {
	if (!aggregate.coupon) {
		throw new Error('Cannot schedule coupon expiry without an issued coupon')
	}
	return {
		type: 'ScheduleWake',
		wakeId: scheduleWakeId({
			journeyId: aggregate.journeyId,
			semanticStepId: 'coupon.expiry',
		}),
		journeyId: aggregate.journeyId,
		dueAt: aggregate.coupon.expiresAt,
		purpose: { type: 'CouponExpiry' },
	}
}

function accepted(args: {
	input: DecideEvergreenOfferJourneyInput
	from: JourneyPhase | 'not_started'
	next: EvergreenOfferJourneyAggregate
	events?: readonly JourneyDomainEvent[]
	sideEffectIntents?: readonly SideEffectIntent[]
	wakeIntents?: readonly ScheduleWakeIntent[]
}): JourneyDecisionResult {
	return {
		ok: true,
		decision: {
			type: 'Accepted',
			next: args.next,
			events: args.events ?? [],
			sideEffectIntents: args.sideEffectIntents ?? [],
			wakeIntents: args.wakeIntents ?? [],
			transitionReceipt: {
				stimulusId: args.input.stimulus.stimulusId,
				journeyId: args.next.journeyId,
				from: args.from,
				to: args.next.phase,
				committedAt: args.input.now,
				evidenceVersion: args.input.currentFacts.evidenceVersion,
			},
		},
	}
}

function ignored(
	reason: Extract<JourneyDecision, { type: 'Ignored' }>['reason'],
	current: EvergreenOfferJourneyAggregate | null,
): JourneyDecisionResult {
	return { ok: true, decision: { type: 'Ignored', reason, current } }
}

function requirePhase(
	from: JourneyPhase | 'not_started',
	event: JourneyPhaseEvent,
):
	| { readonly ok: true; readonly phase: JourneyPhase }
	| { readonly ok: false; readonly error: JourneyDecisionError } {
	const result = transitionJourneyPhase({ from, event })
	return result.ok
		? result
		: {
				ok: false,
				error: {
					type: 'InvariantViolation',
					reason: `Phase ${from} cannot accept ${event.type}`,
				},
			}
}

function decisionError(
	type: JourneyDecisionError['type'],
	reason: string,
): JourneyDecisionResult {
	return { ok: false, error: { type, reason } }
}

function event<Type extends JourneyDomainEvent['type']>(
	type: Type,
	occurredAt: IsoInstant,
	details: Extract<JourneyDomainEvent, { type: Type }>['details'],
): Extract<JourneyDomainEvent, { type: Type }> {
	// SAFETY: the discriminant and details are linked by Extract in this signature.
	return { type, occurredAt, details } as Extract<
		JourneyDomainEvent,
		{ type: Type }
	>
}

function validateDefinition(
	definition: DecideEvergreenOfferJourneyInput['definition'],
): string | null {
	const messages = [...definition.bridge, ...definition.pitch]
	const slotIds = messages.map((message) => message.slotId)
	if (new Set(slotIds).size !== slotIds.length) {
		return 'Journey definition contains duplicate message slot IDs'
	}
	const contentResourceIds = messages.map(
		(message) => message.contentResourceId,
	)
	if (new Set(contentResourceIds).size !== contentResourceIds.length) {
		return 'Journey definition contains duplicate content resource IDs'
	}
	return null
}

function isFinal(
	aggregate: EvergreenOfferJourneyAggregate,
): aggregate is FinalJourneyAggregate {
	return (
		aggregate.phase === 'customer' ||
		aggregate.phase === 'stopped' ||
		aggregate.phase === 'complete'
	)
}
