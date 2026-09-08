import { Effect, Either } from 'effect'
import { isDeepStrictEqual } from 'node:util'
import type { MessagePreparationGate } from './message-preparation-gate'
import {
	captureRevisionScope,
	type DeliveryRevisionScope,
	type RevisionHoldReason,
} from './revision-scope'

import {
	refusalObservation,
	type AcceptedOutcome,
	type AttemptEvidence,
	type AttemptOutcome,
	type ObservedKnownNotAppliedOutcome,
} from './attempt-evidence'
import type {
	DeliveryOutcome,
	DeliverySettled,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	MessageSlot,
	SendMessageIntent,
} from './domain'
import type {
	RecordedOutcomeRecoveryCursor,
	RecoveryCursor,
	createDrizzleJourneyAttempts,
} from './drizzle-attempts'
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
			/**
			 * The provider's own membership instant, or null when the provider did not
			 * supply a usable one. Never the observation time. Only this instant may
			 * bind presence to a specific claim.
			 */
			readonly addedAt: IsoInstant | null
			/** When the read happened. Audit only; never recorded as acceptance time. */
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
	readonly revisionScope: DeliveryRevisionScope
	readonly ledger: JourneyLedger
	readonly service: Pick<EvergreenOfferJourneyService, 'advance'>
	readonly authority: OfferAuthority
	readonly clock: JourneyClock
	readonly attempts: JourneyAttempts
	readonly delivery: DeliveryPort
	readonly reconciliation: DeliveryReconciliation
	readonly preparation?: MessagePreparationGate
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
	| 'mapping-persisted'
	| 'mapping-may-have-persisted'
	| 'preparation-persisted'
	| 'fields-may-have-changed'
	| 'provider-called'
	| 'attempt-recorded'

export type NotClaimedReason =
	| 'PreparationUnavailable'
	| 'MappingUnavailable'
	| RevisionHoldReason
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
	| { readonly type: 'RevisionHeld'; readonly reason: RevisionHoldReason }
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
			/**
			 * A stored refusal with no recorded observation instant (legacy row). No
			 * substitute time exists, so no stimulus is built. Held until an operator
			 * decides; nothing is repaired or rewritten.
			 */
			readonly type: 'EvidenceGap'
			readonly stimulusId: StimulusId
			readonly reason: 'refusal-observation-missing'
	  }
	| {
			/** Command failure; the recorded attempt outcome remains for recovery. */
			readonly type: 'Failed'
			readonly stimulusId: StimulusId
			readonly error: JourneyCommandError['type']
	  }

/**
 * Claimed, then stopped before any provider request with nothing truthful to settle.
 * No attempt outcome is written: the claim stays owned until its lease lapses and
 * then surfaces in recovery as honestly held. Never KnownNotApplied, never a resend.
 */
export type AbandonReason =
	| 'PreparationHeld'
	| 'MappingUnavailable'
	| 'MappingConflict'
	| 'RevisionChangedAfterClaim'
	| 'LeaseExpiredBeforeApply'
	| 'AutomationStoppedAfterClaim'
	| 'NotYetDueAfterClaim'
	| 'WindowClosedAfterClaim'
	| 'ProvenNoRequestFailuresExhausted'

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
			readonly type: 'Abandoned'
			readonly reason: AbandonReason
			readonly detail: string
			/** Apply invocations made under this claim; each one proved no request left. */
			readonly applyInvocations: number
			/** fields-only never means enrollment or inbox delivery. */
			readonly providerRequest: 'none' | 'fields-only'
			readonly sideEffects:
				| 'claimed'
				| 'mapping-persisted'
				| 'mapping-may-have-persisted'
				| 'preparation-persisted'
				| 'fields-may-have-changed'
	  }
	| {
			readonly type: 'Applied'
			readonly meaning: 'provider-accepted-not-inbox-delivery'
			readonly providerReceiptId: string
			readonly appliedAt: IsoInstant
			readonly applyInvocations: number
			readonly sideEffects: 'attempt-recorded'
			readonly settlement: DomainSettlement
	  }
	| {
			readonly type: 'Refused'
			readonly refusal: 'PreflightRefused' | 'ProviderRefused'
			readonly detail: string
			readonly applyInvocations: number
			/** 'none' is proven; 'unknown' means the port refused without proof either way. */
			readonly providerRequest: 'none' | 'fields-only' | 'unknown'
			readonly sideEffects: 'attempt-recorded'
			readonly settlement: DomainSettlement
	  }
	| {
			readonly type: 'HeldUncertain'
			readonly cause: 'EffectAmbiguous' | 'EffectTransientUnavailable'
			readonly detail: string
			readonly applyInvocations: number
			/** The provider may have received a request; nothing proves otherwise. */
			readonly providerRequest: 'unknown'
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
				/** The provider's membership instant, recorded as the acceptance time. */
				readonly addedAt: IsoInstant
				readonly observedAt: IsoInstant
				readonly settlement: DomainSettlement
		  }
		| { readonly type: 'AbsentHeld'; readonly meaning: 'not-resend-permission' }
		| {
				/** Membership is real but its instant does not bind to this claim. Nothing written. */
				readonly type: 'MembershipHeld'
				readonly reason:
					| 'PrecedesClaim'
					| 'PrecedesWindow'
					| 'AfterWindow'
					| 'InFuture'
				readonly addedAt: IsoInstant
				readonly observedAt: IsoInstant
		  }
		| { readonly type: 'UnknownHeld'; readonly reason: string }
		| { readonly type: 'UnsupportedIntentType' }
		| { readonly type: 'IntentUnavailable'; readonly reason: string }
		| { readonly type: 'RecordRefused'; readonly reason: string }
	readonly sideEffects: 'none' | 'attempt-recorded'
}

/**
 * One bounded recovery page. The attempt boundary orders and cuts the page; the
 * executor reports one item per candidate it could act on and never loops over
 * history. Consumer contract:
 * - `limit` is 1..100 per invocation; the boundary refuses anything else as a typed error.
 * - Continue by passing `nextCursor` back unchanged. Advance past every returned item,
 *   including AbsentHeld, UnknownHeld, Declined and Failed ones, or the same retained
 *   rows are re-read forever and later rows starve.
 * - `end` means this query came back short, not permanent exhaustion. Restart from no
 *   cursor periodically: status changes and late rows can move behind a cursor.
 * - Each invocation reads a fresh `now`; keep it non-decreasing across pages.
 * - A malformed row fails the whole page as a typed error. Nothing is quarantined or
 *   deleted; an operator holds the page until the row is repaired.
 */
export type RecoveryPage<Cursor, Item> = {
	readonly results: readonly Item[]
	/** Rows the boundary scanned on this page, including rows with no result. */
	readonly scanned: number
	/** Null only when an initial page was empty. An empty continuation keeps its input. */
	readonly nextCursor: Cursor | null
	readonly end: boolean
}

export interface MessageIntentExecutor {
	/** One durable claim, one apply, truthful settlement. Never reapplies. */
	readonly execute: (
		target: MessageExecutionTarget,
	) => Effect.Effect<MessageExecutionResult, MessageExecutorError>
	/** Submits already recorded Accepted/KnownNotApplied evidence to the domain. No provider work. */
	readonly settleRecordedOutcomes: (input: {
		readonly limit: number
		readonly after?: RecordedOutcomeRecoveryCursor
	}) => Effect.Effect<
		RecoveryPage<RecordedOutcomeRecoveryCursor, RecordedOutcomeSettlement>,
		MessageExecutorError
	>
	/** GET-only reconciliation of expired claims and held attempts. Never resends. */
	readonly reconcileHeld: (input: {
		readonly limit: number
		readonly after?: RecoveryCursor
	}) => Effect.Effect<
		RecoveryPage<RecoveryCursor, HeldReconciliation>,
		MessageExecutorError
	>
}

const DEFAULT_LEASE_MS = 60_000
const MAX_LEASE_MS = 300_000
/**
 * Apply invocations allowed under one still-owned claim. A second invocation happens
 * only when the first proved no request left the process (`requestIssued: false`),
 * so at most one mutating provider request can ever leave per claim.
 */
const MAX_APPLY_INVOCATIONS = 2
const REFUSAL_REASONS = {
	PreflightRefused: 'executor-preflight-refused',
	ProviderRefused: 'provider-refused',
} as const

/**
 * Dormant SendMessage executor. No scheduler, no admission reader, no other intent types.
 * Order: canonical intent read, preflight, durable claim, then per apply invocation a
 * fresh authority, clock, control, window and lease check, DeliveryPort.apply, attempt
 * settlement, then DeliverySettled through the service.
 * Provider acceptance is enrollment acknowledgement, never inbox delivery.
 * KnownNotApplied is not retry permission: one semantic intent gets at most one attempt,
 * and within that attempt at most one provider request. A second apply invocation is
 * allowed only after a typed proof that the first issued no request. Stops, not-yet-due,
 * closed windows and exhausted no-request failures after the claim abandon without
 * writing an outcome, so the claim stays honestly held instead of a counterfeit refusal.
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
	const revisionScope = captureRevisionScope(dependencies.revisionScope)
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

	type CanonicalIntent =
		| { readonly revisionHeld: RevisionHoldReason }
		| {
				readonly aggregate: EvergreenOfferJourneyAggregate
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
			const now = yield* readClock(sideEffects)
			const view = yield* ledger
				.inspect({
					journeyId: aggregate.journeyId,
					now,
					automationControl: 'Stopped',
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
			if (found?.intent.type === 'SendMessage') {
				const revisionHeld = revisionScope.check(view.aggregate, found.intent)
				if (revisionHeld) return { revisionHeld }
			}
			return {
				aggregate: view.aggregate,
				now,
				entry: !found
					? null
					: found.intent.type === 'SendMessage'
						? { intent: structuredClone(found.intent), status: found.status }
						: { unsupported: true },
			}
		})

	const checkCurrentScope = (
		intent: SendMessageIntent,
		now: IsoInstant,
		live = false,
	): Effect.Effect<RevisionHoldReason | null> =>
		Effect.gen(function* () {
			const read = yield* Effect.either(
				ledger.inspect({
					journeyId: intent.journeyId,
					now,
					automationControl: 'Stopped',
				}),
			)
			if (Either.isLeft(read)) return 'RevisionUnavailable' as const
			const row = read.right.intents.find(
				(row) => row.intent.idempotencyKey === intent.idempotencyKey,
			)
			if (!row || !isDeepStrictEqual(row.intent, intent))
				return 'RevisionMismatch' as const
			if (
				live &&
				(!read.right.aggregate ||
					isFinal(read.right.aggregate) ||
					row.status !== 'pending' ||
					slotBinding(read.right.aggregate, intent)?.status !==
						'IntentCommitted')
			)
				return 'RevisionMismatch' as const
			return revisionScope.check(read.right.aggregate, intent)
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
	 * receipts settle at the recorded acceptance instant and refusals at the recorded
	 * observation instant, so live and recovery replays are byte-identical and no clock
	 * is read here. A legacy refusal without an observation is an evidence gap: an
	 * existing commit under the exact stimulus ID is reported, otherwise nothing is built.
	 */
	const settleDomain = (
		intent: SendMessageIntent,
		claimToken: string,
		outcome: Exclude<AttemptOutcome, { type: 'HeldUncertain' }>,
	): Effect.Effect<DomainSettlement, MessageExecutorError> =>
		Effect.gen(function* () {
			const scoped = yield* checkCurrentScope(
				intent,
				yield* readClock('attempt-recorded'),
			)
			if (scoped) return { type: 'RevisionHeld', reason: scoped } as const
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
			const observation =
				outcome.type === 'Accepted'
					? ({ type: 'Known', observedAt: outcome.appliedAt } as const)
					: refusalObservation(outcome)
			if (observation.type === 'Unknown')
				return {
					type: 'EvidenceGap',
					stimulusId,
					reason: 'refusal-observation-missing',
				} as const
			const settledAt = observation.observedAt as IsoInstant
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

	/**
	 * Outcomes this executor may write. A refusal must carry the instant it was actually
	 * observed; the storage-compatible settle signature would accept a legacy shape, so
	 * the narrower type here is what stops an unobserved refusal from compiling.
	 */
	type WrittenOutcome =
		| AcceptedOutcome
		| ObservedKnownNotAppliedOutcome
		| Extract<AttemptOutcome, { type: 'HeldUncertain' }>

	const recordOutcome = (
		evidence: AttemptEvidence,
		outcome: WrittenOutcome,
		sideEffects: SideEffectDisclosure,
	) =>
		Effect.gen(function* () {
			// Fresh clock for settle validation, read after any observation was sampled.
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
			if ('revisionHeld' in canonical) return notClaimed(canonical.revisionHeld)
			if (!canonical.entry) return notClaimed('IntentNotFound')
			if ('unsupported' in canonical.entry)
				return notClaimed('UnsupportedIntentType')
			const { intent, status } = canonical.entry
			if (
				intent.journeyId !== journeyId.value ||
				intent.contactId !== canonical.aggregate.contactId
			)
				return notClaimed('IntentOwnershipMismatch')
			const revisionHold = revisionScope.check(canonical.aggregate, intent)
			if (revisionHold) return notClaimed(revisionHold)
			if (!revisionScope.hasWriter) return notClaimed('MappingUnavailable')
			const requiresPreparation =
				canonical.aggregate.definition.definitionVersion ===
				'evergreen-offer-v3'
			if (requiresPreparation && !dependencies.preparation)
				return notClaimed('PreparationUnavailable')
			if (status !== 'pending') return notClaimed('IntentNotPending')
			if (isFinal(canonical.aggregate)) return notClaimed('JourneyNotActive')
			const slot = slotBinding(canonical.aggregate, intent)
			if (
				!slot ||
				slot.status !== 'IntentCommitted' ||
				slot.intentKey !== intent.idempotencyKey
			)
				return notClaimed('SlotBindingMismatch')
			// Foreign/missing scopes never reach even an authority-provider read.
			const facts = yield* readFacts(
				{ contactId: intent.contactId, journeyId: intent.journeyId },
				'none',
			)
			const now = yield* readClock('none')
			const blocked = controlBlock(facts)
			if (blocked) return notClaimed(blocked)
			const window = windowBlock(intent, now)
			if (window) return notClaimed(window)

			const claimedAt = new Date(now)
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
			let mappingSideEffects:
				| 'claimed'
				| 'mapping-persisted'
				| 'mapping-may-have-persisted'
				| 'preparation-persisted'
				| 'fields-may-have-changed' = 'claimed'
			let originalReceipt: unknown = null
			const abandoned = (
				reason: AbandonReason,
				detail: string,
				applyInvocations: number,
			) =>
				({
					type: 'Abandoned',
					reason,
					detail,
					applyInvocations,
					providerRequest:
						mappingSideEffects === 'fields-may-have-changed'
							? 'fields-only'
							: 'none',
					sideEffects: mappingSideEffects,
				}) as const

			let applyInvocations = 0
			let lastNoRequest = ''
			while (true) {
				// Receipt I/O belongs before ALL final checks, never after them.
				const recordedMapping = yield* revisionScope.record(evidence, intent)
				if (recordedMapping.type === 'Held') {
					if (
						mappingSideEffects !== 'mapping-persisted' &&
						recordedMapping.sideEffects !== 'none'
					)
						mappingSideEffects = recordedMapping.sideEffects
					return abandoned(
						recordedMapping.reason,
						recordedMapping.detail,
						applyInvocations,
					)
				}
				mappingSideEffects = 'mapping-persisted'
				if (
					originalReceipt !== null &&
					!isDeepStrictEqual(originalReceipt, recordedMapping.receipt)
				)
					return abandoned(
						'MappingConflict',
						'Original receipt changed during retry',
						applyInvocations,
					)
				originalReceipt = structuredClone(recordedMapping.receipt)
				if (requiresPreparation) {
					mappingSideEffects = 'preparation-persisted'
					const prep = yield* Effect.tryPromise({
						try: () => dependencies.preparation!.prepare(intent, evidence),
						catch: () =>
							failure(
								'AuthorityUnavailable',
								'Preparation unavailable',
								'fields-may-have-changed',
							),
					})
					if (prep.type === 'Held') {
						if (prep.fieldsRequest === 'possible')
							mappingSideEffects = 'fields-may-have-changed'
						return abandoned('PreparationHeld', prep.reason, applyInvocations)
					}
					mappingSideEffects = 'fields-may-have-changed'
					const reserved = yield* Effect.tryPromise({
						try: () =>
							dependencies.preparation!.reserveEnrollment(prep.snapshot),
						catch: () =>
							failure(
								'AttemptUnavailable',
								'Enrollment reservation unavailable',
								'fields-may-have-changed',
							),
					})
					if (!reserved)
						return abandoned(
							'PreparationHeld',
							'EnrollmentReservationUnconfirmed',
							applyInvocations,
						)
				}
				// Fresh authority, control, clock, window and lease before every apply invocation.
				// Nothing from the claim or an earlier invocation is reused.
				const fresh = yield* readFacts(
					{ contactId: intent.contactId, journeyId: intent.journeyId },
					mappingSideEffects,
				)
				const scopeNow = yield* readClock(mappingSideEffects)
				const revisionHold = yield* checkCurrentScope(intent, scopeNow, true)
				if (revisionHold)
					return abandoned(
						'RevisionChangedAfterClaim',
						revisionHold,
						applyInvocations,
					)
				const applyAt = yield* readClock(mappingSideEffects)
				if (new Date(applyAt) >= evidence.leaseExpiresAt)
					return abandoned(
						'LeaseExpiredBeforeApply',
						lastNoRequest || 'lease-expired',
						applyInvocations,
					)
				const control = controlBlock(fresh)
				if (control === 'AutomationStopped')
					// A stop is a pause in the domain, never a refusal. Hold, do not settle.
					return abandoned(
						'AutomationStoppedAfterClaim',
						control,
						applyInvocations,
					)
				if (control) {
					// Purchase and ineligibility are terminal facts the domain refuses on.
					// The observation instant is sampled once, when the refusal is observed.
					const outcome: ObservedKnownNotAppliedOutcome = {
						type: 'KnownNotApplied',
						reason: 'PreflightRefused',
						observedAt: yield* readClock(mappingSideEffects),
					}
					yield* recordOutcome(evidence, outcome, mappingSideEffects)
					const settlement = yield* settleDomain(
						intent,
						evidence.claimToken,
						outcome,
					)
					return {
						type: 'Refused',
						refusal: 'PreflightRefused',
						detail: control,
						applyInvocations,
						providerRequest: requiresPreparation ? 'fields-only' : 'none',
						sideEffects: 'attempt-recorded',
						settlement,
					} as const
				}
				const window = windowBlock(intent, applyAt)
				if (window === 'NotYetDue')
					return abandoned('NotYetDueAfterClaim', window, applyInvocations)
				if (window === 'WindowClosed')
					// The domain marks a closed window Missed on its next wake; no refusal is faked.
					return abandoned('WindowClosedAfterClaim', window, applyInvocations)

				applyInvocations++
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
						applyInvocations,
						sideEffects: 'attempt-recorded',
						settlement,
					} as const
				}
				const error = applied.left
				if (
					error.type === 'EffectTransientUnavailable' &&
					error.requestIssued === false
				) {
					// Proven: no request left the process. Another invocation is safe while the
					// claim is still owned and every fresh check passes again.
					lastNoRequest = error.reason
					if (applyInvocations < MAX_APPLY_INVOCATIONS) continue
					return abandoned(
						'ProvenNoRequestFailuresExhausted',
						error.reason,
						applyInvocations,
					)
				}
				if (error.type !== 'EffectPermanentRefusal') {
					// Ambiguous, or transient without proof of no request: the provider may have
					// received it. Hold the claim as uncertain; never retry, never refuse.
					const recorded = yield* Effect.either(
						recordOutcome(
							evidence,
							{ type: 'HeldUncertain', reason: 'Unknown' },
							'provider-called',
						),
					)
					return {
						type: 'HeldUncertain',
						cause: error.type,
						detail:
							error.type === 'EffectAmbiguous'
								? error.reason
								: `unproven-no-request:${error.reason}`,
						applyInvocations,
						providerRequest: 'unknown',
						sideEffects: Either.isRight(recorded)
							? 'attempt-recorded'
							: 'provider-called',
						settlement: 'none',
					} as const
				}
				// Permanent refusal: no acceptance, and one attempt per intent grants no retry.
				// The observation instant is sampled once, after the provider's answer. If the
				// clock is unavailable here no time is manufactured: the executor fails with
				// `provider-called` disclosed and the claim stays held, never refused.
				const outcome: ObservedKnownNotAppliedOutcome = {
					type: 'KnownNotApplied',
					reason: 'ProviderRefused',
					observedAt: yield* readClock('provider-called'),
				}
				yield* recordOutcome(evidence, outcome, 'provider-called')
				const settlement = yield* settleDomain(
					intent,
					evidence.claimToken,
					outcome,
				)
				return {
					type: 'Refused',
					refusal: 'ProviderRefused',
					detail: error.reason,
					applyInvocations,
					providerRequest: 'unknown',
					sideEffects: 'attempt-recorded',
					settlement,
				} as const
			}
		})

	const settleRecordedOutcomes: MessageIntentExecutor['settleRecordedOutcomes'] =
		(input) =>
			Effect.gen(function* () {
				const now = yield* readClock('none')
				const page = yield* attempts
					.recordedOutcomeRecoveryPage({
						now: new Date(now),
						limit: input.limit,
						...(input.after ? { after: input.after } : {}),
					})
					.pipe(
						Effect.mapError((error) =>
							failure(error.type, error.reason, 'none'),
						),
					)
				const results: RecordedOutcomeSettlement[] = []
				for (const { evidence, intent } of page.candidates) {
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
					const scoped = yield* checkCurrentScope(
						intent,
						yield* readClock('none'),
					)
					const mapping =
						!scoped && (yield* revisionScope.original(evidence, intent))
					const settlement: RecordedOutcomeSettlement['settlement'] =
						scoped || !mapping
							? {
									type: 'RevisionHeld',
									reason: scoped ?? 'OriginalMappingUnavailable',
								}
							: yield* settleDomain(intent, evidence.claimToken, outcome)
					results.push({
						idempotencyKey: intent.idempotencyKey,
						journeyId: intent.journeyId,
						attemptStatus: outcome.type,
						settlement,
					})
				}
				return {
					results,
					scanned: page.scanned,
					nextCursor: page.nextCursor,
					end: page.end,
				}
			})

	const reconcileHeld: MessageIntentExecutor['reconcileHeld'] = (input) =>
		Effect.gen(function* () {
			const now = yield* readClock('none')
			const page = yield* attempts
				.recoveryPage({
					now: new Date(now),
					limit: input.limit,
					...(input.after ? { after: input.after } : {}),
				})
				.pipe(
					Effect.mapError((error) => failure(error.type, error.reason, 'none')),
				)
			const results: HeldReconciliation[] = []
			for (const { evidence } of page.candidates) {
				const journeyId = parseJourneyId(evidence.journeyId)
				const idempotencyKey = parseIntentKey(evidence.idempotencyKey)
				// The boundary already validated both; a failure here is still scanned,
				// so the cursor moves past it instead of re-reading it forever.
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
				if (Either.isLeft(canonical)) {
					results.push(
						item({ type: 'IntentUnavailable', reason: canonical.left.type }),
					)
					continue
				}
				if ('revisionHeld' in canonical.right) {
					results.push(
						item({ type: 'UnknownHeld', reason: canonical.right.revisionHeld }),
					)
					continue
				}
				if (!canonical.right.entry) {
					results.push(
						item({ type: 'IntentUnavailable', reason: 'IntentNotFound' }),
					)
					continue
				}
				if ('unsupported' in canonical.right.entry) {
					results.push(item({ type: 'UnsupportedIntentType' }))
					continue
				}
				const intent = canonical.right.entry.intent
				const scoped = revisionScope.check(canonical.right.aggregate, intent)
				if (scoped || !(yield* revisionScope.original(evidence, intent))) {
					results.push(
						item({
							type: 'UnknownHeld',
							reason: scoped ?? 'OriginalMappingUnavailable',
						}),
					)
					continue
				}
				// Receipt I/O can yield. Recheck the original canonical intent before GET.
				const beforeRead = yield* checkCurrentScope(
					intent,
					yield* readClock('none'),
				)
				if (beforeRead) {
					results.push(item({ type: 'UnknownHeld', reason: beforeRead }))
					continue
				}
				const membership = yield* reconciliation.inspect(intent)
				const afterRead = yield* checkCurrentScope(
					intent,
					yield* readClock('none'),
				)
				if (afterRead) {
					results.push(item({ type: 'UnknownHeld', reason: afterRead }))
					continue
				}
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
				if (membership.addedAt === null) {
					// Presence without a provider instant cannot be bound to this claim.
					results.push(
						item({
							type: 'UnknownHeld',
							reason: 'membership-added-at-unknown',
						}),
					)
					continue
				}
				const recordedAt = yield* readClock('none')
				const addedAt = Date.parse(membership.addedAt)
				const held =
					addedAt < evidence.claimedAt.getTime()
						? 'PrecedesClaim'
						: addedAt < Date.parse(intent.notBefore)
							? 'PrecedesWindow'
							: addedAt >= Date.parse(intent.notAfter)
								? 'AfterWindow'
								: addedAt > Date.parse(recordedAt)
									? 'InFuture'
									: null
				if (held) {
					// Real membership from another path or time. Kept as evidence, never retimed.
					results.push(
						item({
							type: 'MembershipHeld',
							reason: held,
							addedAt: membership.addedAt,
							observedAt: membership.observedAt,
						}),
					)
					continue
				}
				const outcome: AcceptedOutcome = {
					type: 'Accepted',
					providerReceiptId: membership.providerReceiptId,
					appliedAt: membership.addedAt,
				}
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
							addedAt: membership.addedAt,
							observedAt: membership.observedAt,
							settlement,
						},
						'attempt-recorded',
					),
				)
			}
			return {
				results,
				scanned: page.scanned,
				nextCursor: page.nextCursor,
				end: page.end,
			}
		})

	return { execute, settleRecordedOutcomes, reconcileHeld }
}

function notClaimed(reason: NotClaimedReason): MessageExecutionResult {
	return { type: 'NotClaimed', reason, sideEffects: 'none' }
}

/**
 * Adapts the existing Kit port's GET-only membership read. The provider's `added_at`
 * (already normalised by the port, null when unusable) is passed through untouched as
 * `addedAt`; the shared clock only stamps `observedAt` for audit. The receipt names an
 * observation, never a send.
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
					addedAt: membership.addedAt,
					observedAt: observedAt.right,
				} as const
			}),
	}
}
