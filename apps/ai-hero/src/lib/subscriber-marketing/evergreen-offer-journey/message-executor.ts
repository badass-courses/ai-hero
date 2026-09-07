import { Effect, Either } from 'effect'

import type {
	AcceptedOutcome,
	AttemptEvidence,
	AttemptOutcome,
} from './attempt-evidence'
import type {
	DeliveryOutcome,
	DeliverySettled,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	MessageSlot,
	SendMessageIntent,
} from './domain'
import type { createDrizzleJourneyAttempts } from './drizzle-attempts'
import type { createKitDeliveryPort } from './kit-delivery'
import { restoreEvergreenOfferAuthority } from './persistence-codec'
import type {
	DeliveryPort,
	EvergreenOfferJourneyService,
	JourneyClock,
	JourneyCommandError,
	JourneyLedger,
	OfferAuthority,
} from './ports'
import {
	parseIntentKey,
	parseJourneyId,
	parseStimulusId,
	type ContactId,
	type IntentKey,
	type IsoInstant,
	type JourneyId,
	type StimulusId,
} from './primitives'

/** Durable attempt persistence exactly as the existing Drizzle repository exposes it. */
export type JourneyAttempts = ReturnType<typeof createDrizzleJourneyAttempts>

export type DeliveryMembershipEvidence =
	| {
			readonly type: 'Present'
			/** Read-only membership observation. Must never be manufactured from a send. */
			readonly providerReceiptId: string
			readonly observedAt: IsoInstant
	  }
	| {
			readonly type: 'Absent'
			readonly meaning: 'complete-read-not-resend-permission'
	  }
	| { readonly type: 'Unknown'; readonly reason: string }

/** GET-only provider inspection. Absence or unknown never clears a claim. */
export interface DeliveryReconciliation {
	readonly inspect: (
		intent: SendMessageIntent,
	) => Effect.Effect<DeliveryMembershipEvidence>
}

export type MessageExecutorDependencies = {
	readonly ledger: JourneyLedger
	readonly service: Pick<EvergreenOfferJourneyService, 'advance'>
	readonly authority: OfferAuthority
	readonly clock: JourneyClock
	readonly attempts: JourneyAttempts
	readonly delivery: DeliveryPort
	readonly reconciliation: DeliveryReconciliation
	/** Claim lease in milliseconds; the attempt boundary caps it at five minutes. */
	readonly leaseMs?: number
}

export type MessageExecutionTarget = {
	readonly idempotencyKey: string
	readonly journeyId: string
}

export type SideEffectDisclosure =
	| 'none'
	| 'claimed'
	| 'provider-called'
	| 'attempt-recorded'

export type NotClaimedReason =
	| 'JourneyNotFound'
	| 'IntentNotFound'
	| 'UnsupportedIntentType'
	| 'IntentOwnershipMismatch'
	| 'SlotBindingMismatch'
	| 'IntentNotPending'
	| 'JourneyNotActive'
	| 'AutomationStopped'
	| 'PurchaseObserved'
	| 'DeliveryIneligible'
	| 'NotYetDue'
	| 'WindowClosed'

export type PreflightRefusalCode =
	| 'AutomationStopped'
	| 'PurchaseObserved'
	| 'DeliveryIneligible'
	| 'WindowClosed'
	| 'NotYetDue'

export type DomainSettlement =
	| { readonly type: 'Committed'; readonly stimulusId: StimulusId }
	| { readonly type: 'AlreadyCommitted'; readonly stimulusId: StimulusId }
	| {
			/** The service ignored the receipt; attempt evidence stays discoverable. */
			readonly type: 'Declined'
			readonly stimulusId: StimulusId
			readonly reason: string
	  }
	| {
			/** The service committed a transition that did not settle this slot (journey exited). */
			readonly type: 'Unsettled'
			readonly stimulusId: StimulusId
			readonly reason: string
	  }
	| {
			/** Command failure; the recorded attempt outcome remains for recovery. */
			readonly type: 'Failed'
			readonly stimulusId: StimulusId
			readonly error: JourneyCommandError['type']
	  }

export type MessageExecutionResult =
	| {
			readonly type: 'NotClaimed'
			readonly reason: NotClaimedReason
			readonly sideEffects: 'none'
	  }
	| {
			readonly type: 'AlreadyAttempted'
			readonly state: AttemptEvidence['status']
			readonly sideEffects: 'none'
	  }
	| {
			/** Claimed, then the lease expired before apply. No provider call. The claim surfaces as held. */
			readonly type: 'Abandoned'
			readonly reason: 'LeaseExpiredBeforeApply'
			readonly sideEffects: 'claimed'
	  }
	| {
			readonly type: 'Applied'
			readonly meaning: 'provider-accepted-not-inbox-delivery'
			readonly providerReceiptId: string
			readonly appliedAt: IsoInstant
			readonly sideEffects: 'attempt-recorded'
			readonly settlement: DomainSettlement
	  }
	| {
			readonly type: 'Refused'
			readonly refusal: 'PreflightRefused' | 'ProviderRefused'
			readonly detail: string
			readonly sideEffects: 'attempt-recorded'
			readonly settlement: DomainSettlement
	  }
	| {
			readonly type: 'HeldUncertain'
			readonly detail: string
			readonly sideEffects: 'provider-called' | 'attempt-recorded'
			readonly settlement: 'none'
	  }

export type MessageExecutorError = {
	readonly type:
		| 'InvalidTarget'
		| 'AuthorityUnavailable'
		| 'AuthorityInconsistent'
		| 'ClockUnavailable'
		| 'LedgerUnavailable'
		| 'AttemptUnavailable'
		| 'AttemptRefused'
	readonly reason: string
	readonly sideEffects: SideEffectDisclosure
}

export type RecordedOutcomeSettlement = {
	readonly idempotencyKey: IntentKey
	readonly journeyId: JourneyId
	readonly attemptStatus: 'Accepted' | 'KnownNotApplied'
	readonly settlement:
		| DomainSettlement
		| { readonly type: 'UnsupportedIntentType' }
}

export type HeldReconciliation = {
	readonly idempotencyKey: IntentKey
	readonly journeyId: JourneyId
	readonly result:
		| {
				readonly type: 'ReconciledAccepted'
				readonly providerReceiptId: string
				readonly observedAt: IsoInstant
				readonly settlement: DomainSettlement
		  }
		| { readonly type: 'AbsentHeld'; readonly meaning: 'not-resend-permission' }
		| { readonly type: 'UnknownHeld'; readonly reason: string }
		| { readonly type: 'UnsupportedIntentType' }
		| { readonly type: 'IntentUnavailable'; readonly reason: string }
		| { readonly type: 'RecordRefused'; readonly reason: string }
	readonly sideEffects: 'none' | 'attempt-recorded'
}

export interface MessageIntentExecutor {
	/** One durable claim, one apply, truthful settlement. Never reapplies. */
	readonly execute: (
		target: MessageExecutionTarget,
	) => Effect.Effect<MessageExecutionResult, MessageExecutorError>
	/** Submits already recorded Accepted/KnownNotApplied evidence to the domain. No provider work. */
	readonly settleRecordedOutcomes: (input: {
		readonly limit: number
	}) => Effect.Effect<
		readonly RecordedOutcomeSettlement[],
		MessageExecutorError
	>
	/** GET-only reconciliation of expired claims and held attempts. Never resends. */
	readonly reconcileHeld: (input: {
		readonly limit: number
	}) => Effect.Effect<readonly HeldReconciliation[], MessageExecutorError>
}

const DEFAULT_LEASE_MS = 60_000
const MAX_LEASE_MS = 300_000
const REFUSAL_REASONS = {
	PreflightRefused: 'executor-preflight-refused',
	ProviderRefused: 'provider-refused',
} as const

/**
 * Dormant SendMessage executor. No scheduler, no admission reader, no other intent types.
 * Order: canonical intent read, preflight, durable claim, fresh authority and clock,
 * one DeliveryPort.apply, attempt settlement, then DeliverySettled through the service.
 * Provider acceptance is enrollment acknowledgement, never inbox delivery.
 * KnownNotApplied is not retry permission: one semantic intent gets at most one attempt.
 */
export function createMessageIntentExecutor(
	dependencies: MessageExecutorDependencies,
): MessageIntentExecutor {
	const {
		ledger,
		service,
		authority,
		clock,
		attempts,
		delivery,
		reconciliation,
	} = dependencies
	const leaseMs = Math.min(
		Math.max(1, Math.floor(dependencies.leaseMs ?? DEFAULT_LEASE_MS)),
		MAX_LEASE_MS,
	)

	const failure = (
		type: MessageExecutorError['type'],
		reason: string,
		sideEffects: SideEffectDisclosure = 'none',
	): MessageExecutorError => ({ type, reason, sideEffects })

	const readClock = (sideEffects: SideEffectDisclosure) =>
		clock.now.pipe(
			Effect.mapError((error) =>
				failure('ClockUnavailable', error.reason, sideEffects),
			),
		)

	const readFacts = (
		query: { contactId: ContactId; journeyId: JourneyId },
		sideEffects: SideEffectDisclosure,
	): Effect.Effect<EligibilityFacts, MessageExecutorError> =>
		Effect.gen(function* () {
			const response = yield* authority
				.currentFacts(query)
				.pipe(
					Effect.mapError((error) =>
						failure(
							error.type === 'AuthorityInconsistent'
								? 'AuthorityInconsistent'
								: 'AuthorityUnavailable',
							'reason' in error ? error.reason : error.type,
							sideEffects,
						),
					),
				)
			const restored = restoreEvergreenOfferAuthority(response)
			if (!restored.ok)
				return yield* Effect.fail(
					failure('AuthorityInconsistent', restored.error.reason, sideEffects),
				)
			if (
				restored.value.contactId !== query.contactId ||
				restored.value.existingJourneyId !== query.journeyId
			)
				return yield* Effect.fail(
					failure(
						'AuthorityInconsistent',
						'Current authority belongs to another contact or journey',
						sideEffects,
					),
				)
			return restored.value
		})

	const readSnapshot = (journeyId: JourneyId) =>
		ledger
			.load(journeyId)
			.pipe(
				Effect.mapError((error) =>
					failure('LedgerUnavailable', error.reason, 'none'),
				),
			)

	type CanonicalIntent = {
		readonly aggregate: EvergreenOfferJourneyAggregate
		readonly facts: EligibilityFacts
		readonly now: IsoInstant
		readonly entry:
			| {
					readonly intent: SendMessageIntent
					readonly status:
						| 'pending'
						| 'applied'
						| 'refused'
						| 'ambiguous'
						| 'missed'
			  }
			| { readonly unsupported: true }
			| null
	}

	/** Canonical persisted intent through the existing ledger inspection codec. */
	const readCanonicalIntent = (
		aggregate: EvergreenOfferJourneyAggregate,
		idempotencyKey: IntentKey,
		sideEffects: SideEffectDisclosure,
	): Effect.Effect<CanonicalIntent, MessageExecutorError> =>
		Effect.gen(function* () {
			const facts = yield* readFacts(
				{ contactId: aggregate.contactId, journeyId: aggregate.journeyId },
				sideEffects,
			)
			const now = yield* readClock(sideEffects)
			const view = yield* ledger
				.inspect({
					journeyId: aggregate.journeyId,
					now,
					automationControl: facts.automationControl.type,
				})
				.pipe(
					Effect.mapError((error) =>
						failure(
							'LedgerUnavailable',
							'reason' in error ? error.reason : error.type,
							sideEffects,
						),
					),
				)
			const found = view.intents.find(
				(candidate) => candidate.intent.idempotencyKey === idempotencyKey,
			)
			return {
				aggregate: view.aggregate,
				facts,
				now,
				entry: !found
					? null
					: found.intent.type === 'SendMessage'
						? { intent: found.intent, status: found.status }
						: { unsupported: true },
			}
		})

	const activeSlots = (aggregate: EvergreenOfferJourneyAggregate) => [
		...aggregate.messagePlan.bridge,
		...aggregate.messagePlan.pitch,
	]

	const slotBinding = (
		aggregate: EvergreenOfferJourneyAggregate,
		intent: SendMessageIntent,
	): MessageSlot | null => {
		const slot = activeSlots(aggregate).find(
			(candidate) => candidate.slotId === intent.slotId,
		)
		if (
			!slot ||
			slot.contentResourceId !== intent.contentResourceId ||
			slot.dueAt !== intent.notBefore ||
			slot.windowEndsAt !== intent.notAfter
		)
			return null
		return slot
	}

	const isFinal = (aggregate: EvergreenOfferJourneyAggregate) =>
		aggregate.phase === 'customer' ||
		aggregate.phase === 'stopped' ||
		aggregate.phase === 'complete'

	const controlBlock = (
		facts: EligibilityFacts,
	): PreflightRefusalCode | null =>
		facts.automationControl.type === 'Stopped'
			? 'AutomationStopped'
			: facts.purchase
				? 'PurchaseObserved'
				: facts.delivery.type !== 'Eligible'
					? 'DeliveryIneligible'
					: null

	const windowBlock = (
		intent: SendMessageIntent,
		now: IsoInstant,
	): 'NotYetDue' | 'WindowClosed' | null =>
		Date.parse(now) < Date.parse(intent.notBefore)
			? 'NotYetDue'
			: Date.parse(now) >= Date.parse(intent.notAfter)
				? 'WindowClosed'
				: null

	const settlementStimulusId = (
		intent: SendMessageIntent,
		claimToken: string,
	): StimulusId => {
		const parsed = parseStimulusId(
			`${intent.idempotencyKey}:attempt:${claimToken}:delivery-settled`,
		)
		if (!parsed.ok)
			throw new Error('Attempt token produced a blank stimulus ID')
		return parsed.value
	}

	const domainOutcome = (
		outcome: Exclude<AttemptOutcome, { type: 'HeldUncertain' }>,
	): DeliveryOutcome =>
		outcome.type === 'Accepted'
			? { type: 'Applied', providerReceiptId: outcome.providerReceiptId }
			: { type: 'MessageRefused', reason: REFUSAL_REASONS[outcome.reason] }

	/**
	 * Submits one DeliverySettled receipt bound to the exact attempt token. Accepted
	 * receipts settle at the recorded acceptance instant, so replays are byte-identical.
	 * Refusals carry no recorded instant; an earlier commit under the same stimulus ID wins.
	 */
	const settleDomain = (
		intent: SendMessageIntent,
		claimToken: string,
		outcome: Exclude<AttemptOutcome, { type: 'HeldUncertain' }>,
	): Effect.Effect<DomainSettlement, MessageExecutorError> =>
		Effect.gen(function* () {
			const stimulusId = settlementStimulusId(intent, claimToken)
			const existing = yield* Effect.either(
				ledger.findCommittedStimulus(stimulusId),
			)
			if (Either.isLeft(existing))
				return {
					type: 'Failed',
					stimulusId,
					error: existing.left.type,
				} as const
			if (existing.right)
				return { type: 'AlreadyCommitted', stimulusId } as const
			const settledAt =
				outcome.type === 'Accepted'
					? (outcome.appliedAt as IsoInstant)
					: yield* readClock('attempt-recorded')
			const stimulus: DeliverySettled = {
				type: 'DeliverySettled',
				stimulusId,
				journeyId: intent.journeyId,
				slotId: intent.slotId,
				intentKey: intent.idempotencyKey,
				settledAt,
				outcome: domainOutcome(outcome),
			}
			const advanced = yield* Effect.either(service.advance(stimulus))
			if (Either.isLeft(advanced))
				return {
					type: 'Failed',
					stimulusId,
					error: advanced.left.type,
				} as const
			const decision = advanced.right.decision
			if (decision.type === 'Ignored')
				return {
					type: 'Declined',
					stimulusId,
					reason: decision.reason,
				} as const
			const settled = decision.events.some(
				(event) =>
					event.type === 'MessageSettled' &&
					event.details.intentKey === intent.idempotencyKey,
			)
			if (!settled)
				return {
					type: 'Unsettled',
					stimulusId,
					reason:
						'exit' in decision.next
							? `journey-exited:${decision.next.exit.type}`
							: 'no-message-settlement-event',
				} as const
			return advanced.right.replayedStimulus
				? ({ type: 'AlreadyCommitted', stimulusId } as const)
				: ({ type: 'Committed', stimulusId } as const)
		})

	const recordOutcome = (
		evidence: AttemptEvidence,
		outcome: AttemptOutcome,
		sideEffects: SideEffectDisclosure,
	) =>
		Effect.gen(function* () {
			const now = yield* readClock(sideEffects)
			const identity = {
				idempotencyKey: evidence.idempotencyKey,
				journeyId: evidence.journeyId,
				claimToken: evidence.claimToken,
				now: new Date(now),
			}
			const settled = yield* Effect.either(
				attempts.settle({ ...identity, outcome }),
			)
			if (Either.isRight(settled)) return settled.right
			// A live acceptance whose lease lapsed is still exact-token provider evidence.
			if (outcome.type === 'Accepted' && settled.left.type === 'AttemptRefused')
				return yield* attempts
					.reconcileAccepted({ ...identity, outcome })
					.pipe(
						Effect.mapError((error) =>
							failure(error.type, error.reason, sideEffects),
						),
					)
			return yield* Effect.fail(
				failure(settled.left.type, settled.left.reason, sideEffects),
			)
		})

	const execute: MessageIntentExecutor['execute'] = (target) =>
		Effect.gen(function* () {
			const idempotencyKey = parseIntentKey(target.idempotencyKey)
			const journeyId = parseJourneyId(target.journeyId)
			if (!idempotencyKey.ok || !journeyId.ok)
				return yield* Effect.fail(
					failure('InvalidTarget', 'Intent key and journey ID are required'),
				)
			const snapshot = yield* readSnapshot(journeyId.value)
			if (!snapshot) return notClaimed('JourneyNotFound')
			const canonical = yield* readCanonicalIntent(
				snapshot,
				idempotencyKey.value,
				'none',
			)
			if (!canonical.entry) return notClaimed('IntentNotFound')
			if ('unsupported' in canonical.entry)
				return notClaimed('UnsupportedIntentType')
			const { intent, status } = canonical.entry
			if (
				intent.journeyId !== journeyId.value ||
				intent.contactId !== canonical.aggregate.contactId
			)
				return notClaimed('IntentOwnershipMismatch')
			if (status !== 'pending') return notClaimed('IntentNotPending')
			if (isFinal(canonical.aggregate)) return notClaimed('JourneyNotActive')
			const slot = slotBinding(canonical.aggregate, intent)
			if (
				!slot ||
				slot.status !== 'IntentCommitted' ||
				slot.intentKey !== intent.idempotencyKey
			)
				return notClaimed('SlotBindingMismatch')
			const blocked = controlBlock(canonical.facts)
			if (blocked) return notClaimed(blocked)
			const window = windowBlock(intent, canonical.now)
			if (window) return notClaimed(window)

			const claimedAt = new Date(canonical.now)
			const claim = yield* attempts
				.claim({
					idempotencyKey: intent.idempotencyKey,
					journeyId: intent.journeyId,
					now: claimedAt,
					leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
				})
				.pipe(
					Effect.mapError((error) => failure(error.type, error.reason, 'none')),
				)
			if (claim.type === 'AlreadyAttempted')
				return {
					type: 'AlreadyAttempted',
					state: claim.state,
					sideEffects: 'none',
				} as const
			const evidence = claim.evidence

			// Fresh authority, control and clock immediately before the only apply.
			const fresh = yield* readFacts(
				{ contactId: intent.contactId, journeyId: intent.journeyId },
				'claimed',
			)
			const applyAt = yield* readClock('claimed')
			if (new Date(applyAt) >= evidence.leaseExpiresAt)
				return {
					type: 'Abandoned',
					reason: 'LeaseExpiredBeforeApply',
					sideEffects: 'claimed',
				} as const
			const refusal = controlBlock(fresh) ?? windowBlock(intent, applyAt)
			if (refusal) {
				const outcome = {
					type: 'KnownNotApplied',
					reason: 'PreflightRefused',
				} as const
				yield* recordOutcome(evidence, outcome, 'claimed')
				const settlement = yield* settleDomain(
					intent,
					evidence.claimToken,
					outcome,
				)
				return {
					type: 'Refused',
					refusal: 'PreflightRefused',
					detail: refusal,
					sideEffects: 'attempt-recorded',
					settlement,
				} as const
			}

			const applied = yield* Effect.either(delivery.apply(intent))
			if (Either.isRight(applied)) {
				const outcome: AcceptedOutcome = {
					type: 'Accepted',
					providerReceiptId: applied.right.providerReceiptId,
					appliedAt: applied.right.appliedAt,
				}
				yield* recordOutcome(evidence, outcome, 'provider-called')
				const settlement = yield* settleDomain(
					intent,
					evidence.claimToken,
					outcome,
				)
				return {
					type: 'Applied',
					meaning: 'provider-accepted-not-inbox-delivery',
					providerReceiptId: outcome.providerReceiptId,
					appliedAt: outcome.appliedAt as IsoInstant,
					sideEffects: 'attempt-recorded',
					settlement,
				} as const
			}
			const error = applied.left
			if (error.type === 'EffectAmbiguous') {
				const recorded = yield* Effect.either(
					recordOutcome(
						evidence,
						{ type: 'HeldUncertain', reason: 'Unknown' },
						'provider-called',
					),
				)
				return {
					type: 'HeldUncertain',
					detail: error.reason,
					sideEffects: Either.isRight(recorded)
						? 'attempt-recorded'
						: 'provider-called',
					settlement: 'none',
				} as const
			}
			// Permanent refusal and pre-request transient failure both mean no acceptance.
			// One attempt per intent: neither grants a second apply.
			const outcome = {
				type: 'KnownNotApplied',
				reason:
					error.type === 'EffectPermanentRefusal'
						? 'ProviderRefused'
						: 'PreflightRefused',
			} as const
			yield* recordOutcome(evidence, outcome, 'provider-called')
			const settlement = yield* settleDomain(
				intent,
				evidence.claimToken,
				outcome,
			)
			return {
				type: 'Refused',
				refusal: outcome.reason,
				detail: error.reason,
				sideEffects: 'attempt-recorded',
				settlement,
			} as const
		})

	const settleRecordedOutcomes: MessageIntentExecutor['settleRecordedOutcomes'] =
		(input) =>
			Effect.gen(function* () {
				const now = yield* readClock('none')
				const recovered = yield* attempts
					.recordedOutcomeRecovery({ now: new Date(now), limit: input.limit })
					.pipe(
						Effect.mapError((error) =>
							failure(error.type, error.reason, 'none'),
						),
					)
				const results: RecordedOutcomeSettlement[] = []
				for (const { evidence, intent } of recovered) {
					const outcome = evidence.outcome
					if (!outcome || outcome.type === 'HeldUncertain') continue
					if (intent.type !== 'SendMessage') {
						results.push({
							idempotencyKey: intent.idempotencyKey,
							journeyId: intent.journeyId,
							attemptStatus: outcome.type,
							settlement: { type: 'UnsupportedIntentType' },
						})
						continue
					}
					const settlement = yield* settleDomain(
						intent,
						evidence.claimToken,
						outcome,
					)
					results.push({
						idempotencyKey: intent.idempotencyKey,
						journeyId: intent.journeyId,
						attemptStatus: outcome.type,
						settlement,
					})
				}
				return results
			})

	const reconcileHeld: MessageIntentExecutor['reconcileHeld'] = (input) =>
		Effect.gen(function* () {
			const now = yield* readClock('none')
			const held = yield* attempts
				.recovery({ now: new Date(now), limit: input.limit })
				.pipe(
					Effect.mapError((error) => failure(error.type, error.reason, 'none')),
				)
			const results: HeldReconciliation[] = []
			for (const { evidence } of held) {
				const journeyId = parseJourneyId(evidence.journeyId)
				const idempotencyKey = parseIntentKey(evidence.idempotencyKey)
				if (!journeyId.ok || !idempotencyKey.ok) continue
				const item = (
					result: HeldReconciliation['result'],
					sideEffects: HeldReconciliation['sideEffects'] = 'none',
				): HeldReconciliation => ({
					idempotencyKey: idempotencyKey.value,
					journeyId: journeyId.value,
					result,
					sideEffects,
				})
				const snapshot = yield* Effect.either(readSnapshot(journeyId.value))
				if (Either.isLeft(snapshot) || !snapshot.right) {
					results.push(
						item({
							type: 'IntentUnavailable',
							reason: Either.isLeft(snapshot)
								? snapshot.left.type
								: 'JourneyNotFound',
						}),
					)
					continue
				}
				const canonical = yield* Effect.either(
					readCanonicalIntent(snapshot.right, idempotencyKey.value, 'none'),
				)
				if (Either.isLeft(canonical) || !canonical.right.entry) {
					results.push(
						item({
							type: 'IntentUnavailable',
							reason: Either.isLeft(canonical)
								? canonical.left.type
								: 'IntentNotFound',
						}),
					)
					continue
				}
				if ('unsupported' in canonical.right.entry) {
					results.push(item({ type: 'UnsupportedIntentType' }))
					continue
				}
				const intent = canonical.right.entry.intent
				const membership = yield* reconciliation.inspect(intent)
				if (membership.type === 'Absent') {
					results.push(
						item({ type: 'AbsentHeld', meaning: 'not-resend-permission' }),
					)
					continue
				}
				if (membership.type === 'Unknown') {
					results.push(item({ type: 'UnknownHeld', reason: membership.reason }))
					continue
				}
				const outcome: AcceptedOutcome = {
					type: 'Accepted',
					providerReceiptId: membership.providerReceiptId,
					appliedAt: membership.observedAt,
				}
				const recordedAt = yield* readClock('none')
				const recorded = yield* Effect.either(
					attempts.reconcileAccepted({
						idempotencyKey: evidence.idempotencyKey,
						journeyId: evidence.journeyId,
						claimToken: evidence.claimToken,
						now: new Date(recordedAt),
						outcome,
					}),
				)
				if (Either.isLeft(recorded)) {
					results.push(
						item({ type: 'RecordRefused', reason: recorded.left.reason }),
					)
					continue
				}
				const settlement = yield* settleDomain(
					intent,
					evidence.claimToken,
					outcome,
				)
				results.push(
					item(
						{
							type: 'ReconciledAccepted',
							providerReceiptId: outcome.providerReceiptId,
							observedAt: membership.observedAt,
							settlement,
						},
						'attempt-recorded',
					),
				)
			}
			return results
		})

	return { execute, settleRecordedOutcomes, reconcileHeld }
}

function notClaimed(reason: NotClaimedReason): MessageExecutionResult {
	return { type: 'NotClaimed', reason, sideEffects: 'none' }
}

/**
 * Adapts the existing Kit port's GET-only membership read. Kit membership carries
 * no acceptance timestamp through that port, so the recorded instant is the
 * observation time and the receipt names it as an observation, never a send.
 */
export function createKitMembershipReconciliation(args: {
	readonly port: Pick<ReturnType<typeof createKitDeliveryPort>, 'reconcile'>
	readonly clock: JourneyClock
	readonly maxPages?: number
}): DeliveryReconciliation {
	return {
		inspect: (intent) =>
			Effect.gen(function* () {
				const membership = yield* args.port.reconcile(intent, args.maxPages)
				if (membership.type !== 'Present') return membership
				const observedAt = yield* Effect.either(args.clock.now)
				if (Either.isLeft(observedAt))
					return { type: 'Unknown', reason: 'clock-unavailable' } as const
				return {
					type: 'Present',
					providerReceiptId: `kit:sequence-membership-observed:${intent.contentResourceId}`,
					observedAt: observedAt.right,
				} as const
			}),
	}
}
