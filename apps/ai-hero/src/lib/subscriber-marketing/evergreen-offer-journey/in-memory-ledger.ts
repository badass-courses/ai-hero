import { Effect } from 'effect'

import { decideEvergreenOfferJourney } from './decision'
import { inspectEvergreenOfferJourney } from './inspection'
import {
	EVERGREEN_OFFER_JOURNEY_EVENT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_RECEIPT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_STIMULUS_FORMAT,
	EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT,
	type JourneyIntentRecord,
	type JourneyLedgerRecords,
	type JourneyLedgerSeed,
	type JourneySnapshotRecord,
	type JourneyWakeRecord,
} from './persistence-contract'
import type {
	CommittedJourneyDecision,
	JourneyCommandError,
	JourneyLedger,
	JourneyLedgerCommit,
	JourneyQueryError,
} from './ports'
import {
	journeySnapshotRecord,
	restoreEvergreenOfferJourneySnapshot,
} from './restoration'
import type {
	EvergreenOfferJourneyAggregate,
	JourneyDecision,
	JourneyDomainEvent,
	JourneyView,
} from './domain'
import type { IntentKey, JourneyId } from './primitives'

export type InMemoryJourneyLedger = JourneyLedger & {
	readonly records: () => JourneyLedgerRecords
}

export function makeInMemoryJourneyLedger(
	args: {
		readonly seed?: JourneyLedgerSeed
	} = {},
): InMemoryJourneyLedger {
	const seed = structuredClone(args.seed ?? {})
	const snapshots = [...(seed.snapshots ?? [])]
	const events = [...(seed.events ?? [])]
	const intents = [...(seed.intents ?? [])]
	const wakes = [...(seed.wakes ?? [])]
	const stimuli = [...(seed.stimuli ?? [])]
	const receipts = [...(seed.receipts ?? [])]

	const load: JourneyLedger['load'] = (journeyId) =>
		Effect.suspend(() => {
			const restored = restoreLatestSnapshot({ journeyId, snapshots })
			return restored.ok
				? Effect.succeed(restored.value)
				: Effect.fail(restored.error)
		})

	const findCommittedStimulus: JourneyLedger['findCommittedStimulus'] = (
		stimulusId,
	) =>
		Effect.sync(() => {
			const decision = stimuli.find(
				(record) => record.stimulusId === stimulusId,
			)?.decision
			return decision ? structuredClone(decision) : null
		})

	const commit: JourneyLedger['commit'] = (candidateInput) =>
		Effect.suspend(() => {
			const candidate = structuredClone(candidateInput)
			const replay = stimuli.find(
				(record) => record.stimulusId === candidate.stimulus.stimulusId,
			)
			if (replay) {
				return Effect.succeed(
					structuredClone({
						decision: replay.decision.decision,
						committed: false,
						replayedStimulus: true,
					}),
				)
			}
			const current = restoreLatestSnapshot({
				journeyId: candidate.decision.next.journeyId,
				snapshots,
			})
			if (!current.ok) return Effect.fail(current.error)
			const validationFailure = validateCommit({
				candidate,
				current: current.value,
				intentKeys: new Set(intents.map((record) => record.idempotencyKey)),
				wakeIds: new Set(wakes.map((record) => record.wakeId)),
			})
			if (validationFailure) return Effect.fail(validationFailure)
			const nextSnapshot = journeySnapshotRecord(candidate.decision.next)
			const restoredCandidate = restoreEvergreenOfferJourneySnapshot(
				nextSnapshot.snapshotJson,
			)
			if (!restoredCandidate.ok) {
				return Effect.fail(
					constraintFailure(
						candidate,
						`Next aggregate cannot be restored: ${restoredCandidate.error.reason}`,
					),
				)
			}

			const decision: Extract<JourneyDecision, { type: 'Accepted' }> = {
				type: 'Accepted',
				next: candidate.decision.next,
				events: candidate.decision.events,
				sideEffectIntents: candidate.decision.sideEffectIntents,
				wakeIntents: candidate.decision.wakeIntents,
				transitionReceipt: candidate.decision.transitionReceipt,
			}
			const committed: CommittedJourneyDecision = {
				decision,
				committed: true,
				replayedStimulus: false,
			}
			const actorVersion = candidate.decision.next.version
			const journeyId = candidate.decision.next.journeyId
			const nextEvents = candidate.decision.events.map(
				(event, ordinal) =>
					({
						format: EVERGREEN_OFFER_JOURNEY_EVENT_FORMAT,
						journeyId,
						actorVersion,
						ordinal,
						event,
					}) as const,
			)
			const nextIntents = candidate.decision.sideEffectIntents.map(
				(intent) => ({
					format: EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
					journeyId,
					actorVersion,
					idempotencyKey: intent.idempotencyKey,
					status: 'Pending' as const,
					settledByStimulusId: null,
					intent,
				}),
			)
			const settledIntents = settleIntentRecords({
				records: [...intents, ...nextIntents],
				candidate,
			})
			if (!settledIntents.ok) {
				return Effect.fail(constraintFailure(candidate, settledIntents.reason))
			}
			const nextWakes = candidate.decision.wakeIntents.map((wake) => ({
				format: EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT,
				journeyId,
				actorVersion,
				wakeId: wake.wakeId,
				status: 'Pending' as const,
				settledByStimulusId: null,
				wake,
			}))
			const settledWakes = settleWakeRecords({
				records: [...wakes, ...nextWakes],
				candidate,
			})
			if (!settledWakes.ok) {
				return Effect.fail(constraintFailure(candidate, settledWakes.reason))
			}
			const nextStimulus = {
				format: EVERGREEN_OFFER_JOURNEY_STIMULUS_FORMAT,
				journeyId,
				actorVersion,
				stimulusId: candidate.stimulus.stimulusId,
				stimulus: candidate.stimulus,
				decision: committed,
			} as const
			const nextReceipt = {
				format: EVERGREEN_OFFER_JOURNEY_RECEIPT_FORMAT,
				journeyId,
				actorVersion,
				receipt: candidate.decision.transitionReceipt,
			} as const

			snapshots.push(nextSnapshot)
			events.push(...nextEvents)
			intents.splice(0, intents.length, ...settledIntents.records)
			wakes.splice(0, wakes.length, ...settledWakes.records)
			stimuli.push(nextStimulus)
			receipts.push(nextReceipt)
			return Effect.succeed(structuredClone(committed))
		})

	const inspect: JourneyLedger['inspect'] = (query) =>
		Effect.suspend<JourneyView, JourneyQueryError, never>(() => {
			const { journeyId, now, automationControl } = query
			const restored = restoreLatestSnapshot({ journeyId, snapshots })
			if (!restored.ok) return Effect.fail(restored.error)
			if (!restored.value) {
				return Effect.fail({ type: 'JourneyNotFound' as const, journeyId })
			}
			const aggregate = restored.value
			return Effect.succeed(
				structuredClone(
					inspectEvergreenOfferJourney({
						aggregate,
						now,
						automationControl,
						intentEvidence: intents
							.filter((record) => record.journeyId === journeyId)
							.map((record) => ({
								intent: record.intent,
								status: intentEvidenceStatus(record.status),
							})),
						wakeEvidence: wakes
							.filter((record) => record.journeyId === journeyId)
							.map((record) => ({
								wake: record.wake,
								status: wakeEvidenceStatus(record.status),
							})),
						transitionReceipts: receipts
							.filter((record) => record.journeyId === journeyId)
							.map((record) => record.receipt),
						evidenceVersion: `in-memory:${aggregate.version}`,
					}),
				),
			)
		})

	return {
		load,
		findCommittedStimulus,
		commit,
		inspect,
		records: () =>
			structuredClone({
				snapshots,
				events,
				intents,
				wakes,
				stimuli,
				receipts,
			}),
	}
}

function restoreLatestSnapshot(args: {
	readonly journeyId: JourneyId
	readonly snapshots: readonly JourneySnapshotRecord[]
}):
	| {
			readonly ok: true
			readonly value: EvergreenOfferJourneyAggregate | null
	  }
	| {
			readonly ok: false
			readonly error: Extract<
				JourneyCommandError,
				{ type: 'JourneyDecodeFailure' }
			>
	  } {
	const record = [...args.snapshots]
		.filter((candidate) => candidate.journeyId === args.journeyId)
		.sort((left, right) => right.actorVersion - left.actorVersion)[0]
	if (!record) return { ok: true, value: null }
	const restored = restoreEvergreenOfferJourneySnapshot(record.snapshotJson)
	if (!restored.ok) return restored
	if (
		restored.value.journeyId !== record.journeyId ||
		restored.value.version !== record.actorVersion
	) {
		return {
			ok: false,
			error: {
				type: 'JourneyDecodeFailure',
				reason: 'Snapshot record authority does not match restored aggregate',
			},
		}
	}
	return restored
}

function settleWakeRecords(args: {
	readonly records: readonly JourneyWakeRecord[]
	readonly candidate: JourneyLedgerCommit
}):
	| { readonly ok: true; readonly records: readonly JourneyWakeRecord[] }
	| { readonly ok: false; readonly reason: string } {
	const stimulus = args.candidate.stimulus
	if (stimulus.type !== 'WakeDue') return { ok: true, records: args.records }
	if (!args.records.some((record) => record.wakeId === stimulus.wakeId)) {
		return {
			ok: false,
			reason: `Wake receipt references unknown wake ID ${stimulus.wakeId}`,
		}
	}
	return {
		ok: true,
		records: args.records.map((record) =>
			record.wakeId === stimulus.wakeId
				? {
						...record,
						status: 'Applied',
						settledByStimulusId: stimulus.stimulusId,
					}
				: record,
		),
	}
}

function wakeEvidenceStatus(
	status: JourneyWakeRecord['status'],
): 'pending' | 'applied' {
	return status === 'Pending' ? 'pending' : 'applied'
}

function settleIntentRecords(args: {
	readonly records: readonly JourneyIntentRecord[]
	readonly candidate: JourneyLedgerCommit
}):
	| { readonly ok: true; readonly records: readonly JourneyIntentRecord[] }
	| { readonly ok: false; readonly reason: string } {
	const settlements = new Map<IntentKey, JourneyIntentRecord['status']>()
	const stimulus = args.candidate.stimulus
	switch (stimulus.type) {
		case 'DeliverySettled':
			settlements.set(
				stimulus.intentKey,
				stimulus.outcome.type === 'Applied'
					? 'Applied'
					: stimulus.outcome.type === 'Ambiguous'
						? 'Ambiguous'
						: 'Refused',
			)
			break
		case 'CouponIssued':
		case 'CouponBoundToUser':
		case 'ShadowNewsletterEntered':
			settlements.set(stimulus.intentKey, 'Applied')
			break
		case 'PermanentEffectRefusal':
			settlements.set(stimulus.intentKey, 'Refused')
			break
	}
	for (const event of args.candidate.decision.events) {
		if (event.type === 'MessageMissed' && event.details.intentKey) {
			settlements.set(event.details.intentKey, 'Missed')
		}
	}
	if (settlements.size === 0) return { ok: true, records: args.records }
	const existingKeys = new Set(
		args.records.map((record) => record.idempotencyKey),
	)
	for (const key of settlements.keys()) {
		if (!existingKeys.has(key)) {
			return {
				ok: false,
				reason: `Settlement references unknown intent key ${key}`,
			}
		}
	}
	return {
		ok: true,
		records: args.records.map((record) => {
			const status = settlements.get(record.idempotencyKey)
			return status
				? {
						...record,
						status,
						settledByStimulusId: stimulus.stimulusId,
					}
				: record
		}),
	}
}

function intentEvidenceStatus(
	status: JourneyIntentRecord['status'],
): 'pending' | 'applied' | 'refused' | 'ambiguous' | 'missed' {
	switch (status) {
		case 'Pending':
			return 'pending'
		case 'Applied':
			return 'applied'
		case 'Refused':
			return 'refused'
		case 'Ambiguous':
			return 'ambiguous'
		case 'Missed':
			return 'missed'
	}
}

function validateCommit(args: {
	readonly candidate: JourneyLedgerCommit
	readonly current: EvergreenOfferJourneyAggregate | null
	readonly intentKeys: ReadonlySet<string>
	readonly wakeIds: ReadonlySet<string>
}): JourneyCommandError | null {
	const { candidate, current } = args
	const expectedCurrentVersion = candidate.expectedVersion
	if (
		(current === null && expectedCurrentVersion !== null) ||
		(current !== null && current.version !== expectedCurrentVersion)
	) {
		return {
			type: 'JourneyVersionConflict',
			journeyId: candidate.decision.next.journeyId,
		}
	}
	if (
		current === null &&
		expectedCurrentVersion === null &&
		candidate.decision.next.version !== 1
	) {
		return constraintFailure(candidate, 'Initial actor version must be 1')
	}
	const recomputed = decideEvergreenOfferJourney({
		snapshot: current,
		stimulus: candidate.stimulus,
		currentFacts: candidate.currentFacts,
		definition: candidate.definition,
		now: candidate.decidedAt,
	})
	if (
		!recomputed.ok ||
		recomputed.decision.type !== 'Accepted' ||
		JSON.stringify(recomputed.decision) !== JSON.stringify(candidate.decision)
	) {
		return constraintFailure(
			candidate,
			'Committed decision does not match the pure journey decision',
		)
	}
	if (
		current !== null &&
		(candidate.decision.next.version !== current.version + 1 ||
			candidate.decision.next.journeyId !== current.journeyId ||
			candidate.decision.next.entryFactId !== current.entryFactId ||
			candidate.decision.next.contactId !== current.contactId)
	) {
		return constraintFailure(
			candidate,
			'Next aggregate must preserve actor identity and increment one version',
		)
	}
	const expectedFrom = current?.phase ?? 'not_started'
	if (
		candidate.decision.transitionReceipt.journeyId !==
			candidate.decision.next.journeyId ||
		candidate.decision.transitionReceipt.stimulusId !==
			candidate.stimulus.stimulusId ||
		candidate.decision.transitionReceipt.from !== expectedFrom ||
		candidate.decision.transitionReceipt.to !== candidate.decision.next.phase
	) {
		return constraintFailure(
			candidate,
			'Transition receipt does not agree with the committed snapshot',
		)
	}
	const candidateIntentKeys = candidate.decision.sideEffectIntents.map(
		(intent) => intent.idempotencyKey,
	)
	if (
		new Set(candidateIntentKeys).size !== candidateIntentKeys.length ||
		candidateIntentKeys.some((key) => args.intentKeys.has(key))
	) {
		return constraintFailure(
			candidate,
			'Side-effect intent key must be unique across the ledger',
		)
	}
	const candidateWakeIds = candidate.decision.wakeIntents.map(
		(wake) => wake.wakeId,
	)
	if (
		new Set(candidateWakeIds).size !== candidateWakeIds.length ||
		candidateWakeIds.some((wakeId) => args.wakeIds.has(wakeId))
	) {
		return constraintFailure(
			candidate,
			'Wake ID must be unique across the ledger',
		)
	}
	const eventAgreementFailure = validateEventAgreement(candidate, current)
	if (eventAgreementFailure) {
		return constraintFailure(candidate, eventAgreementFailure)
	}
	if (
		candidate.decision.sideEffectIntents.some(
			(intent) =>
				intent.journeyId !== candidate.decision.next.journeyId ||
				intent.contactId !== candidate.decision.next.contactId,
		) ||
		candidate.decision.wakeIntents.some(
			(wake) => wake.journeyId !== candidate.decision.next.journeyId,
		)
	) {
		return constraintFailure(
			candidate,
			'Committed effects must belong to the committed actor',
		)
	}
	return null
}

function validateEventAgreement(
	candidate: JourneyLedgerCommit,
	current: EvergreenOfferJourneyAggregate | null,
): string | null {
	const started = candidate.decision.events.filter(
		(event): event is Extract<JourneyDomainEvent, { type: 'JourneyStarted' }> =>
			event.type === 'JourneyStarted',
	)
	if (
		(current === null &&
			(started.length !== 1 ||
				started[0]?.details.journeyId !== candidate.decision.next.journeyId)) ||
		(current !== null && started.length !== 0)
	) {
		return 'JourneyStarted event does not agree with actor creation'
	}
	for (const intent of candidate.decision.sideEffectIntents) {
		const matched = candidate.decision.events.some((event) => {
			switch (intent.type) {
				case 'SendMessage':
					return (
						event.type === 'MessageIntentCommitted' &&
						event.details.slotId === intent.slotId &&
						event.details.idempotencyKey === intent.idempotencyKey
					)
				case 'IssueCoupon':
					return (
						event.type === 'CouponIntentCommitted' &&
						event.details.idempotencyKey === intent.idempotencyKey
					)
				case 'BindCoupon':
					return (
						event.type === 'CouponBindingIntentCommitted' &&
						event.details.couponId === intent.couponId &&
						event.details.verifiedUserId === intent.verifiedUserId &&
						event.details.intentKey === intent.idempotencyKey
					)
				case 'EnterShadowNewsletter':
					return (
						event.type === 'HandoffIntentCommitted' &&
						event.details.idempotencyKey === intent.idempotencyKey
					)
			}
		})
		if (!matched) return `${intent.type} intent has no agreeing domain event`
	}
	for (const event of candidate.decision.events) {
		if (event.type === 'MessageIntentCommitted') {
			const intent = candidate.decision.sideEffectIntents.find(
				(candidateIntent) =>
					candidateIntent.type === 'SendMessage' &&
					candidateIntent.idempotencyKey === event.details.idempotencyKey,
			)
			if (
				intent?.type !== 'SendMessage' ||
				intent.slotId !== event.details.slotId
			) {
				return 'MessageIntentCommitted event has no agreeing intent'
			}
		}
		if (event.type === 'CouponIntentCommitted') {
			if (
				!candidate.decision.sideEffectIntents.some(
					(intent) =>
						intent.type === 'IssueCoupon' &&
						intent.idempotencyKey === event.details.idempotencyKey,
				)
			) {
				return 'CouponIntentCommitted event has no agreeing intent'
			}
		}
		if (event.type === 'CouponBindingIntentCommitted') {
			if (
				!candidate.decision.sideEffectIntents.some(
					(intent) =>
						intent.type === 'BindCoupon' &&
						intent.idempotencyKey === event.details.intentKey &&
						intent.couponId === event.details.couponId &&
						intent.verifiedUserId === event.details.verifiedUserId,
				)
			) {
				return 'CouponBindingIntentCommitted event has no agreeing intent'
			}
		}
		if (event.type === 'HandoffIntentCommitted') {
			if (
				!candidate.decision.sideEffectIntents.some(
					(intent) =>
						intent.type === 'EnterShadowNewsletter' &&
						intent.idempotencyKey === event.details.idempotencyKey,
				)
			) {
				return 'HandoffIntentCommitted event has no agreeing intent'
			}
		}
		if (event.type === 'CouponRecorded') {
			if (
				candidate.decision.next.coupon?.couponId !== event.details.couponId ||
				candidate.decision.next.coupon.expiresAt !== event.details.expiresAt
			) {
				return 'CouponRecorded event does not agree with the snapshot'
			}
		}
		if (event.type === 'CouponBindingRecorded') {
			if (
				candidate.decision.next.coupon?.couponId !== event.details.couponId ||
				candidate.decision.next.coupon.binding.type !== 'BoundToVerifiedUser'
			) {
				return 'CouponBindingRecorded event does not agree with the snapshot'
			}
		}
		if (event.type === 'MessageMissed') {
			const slot = allMessageSlots(candidate.decision.next).find(
				(candidateSlot) => candidateSlot.slotId === event.details.slotId,
			)
			if (
				slot?.status !== 'Missed' ||
				slot.intentKey !== event.details.intentKey
			) {
				return 'MessageMissed event does not agree with the snapshot'
			}
		}
		if (event.type === 'MessageSettled') {
			const slot = allMessageSlots(candidate.decision.next).find(
				(candidateSlot) => candidateSlot.slotId === event.details.slotId,
			)
			const expectedStatus =
				event.details.outcome === 'Applied'
					? 'Applied'
					: event.details.outcome === 'Ambiguous'
						? 'Ambiguous'
						: 'Refused'
			if (
				slot?.status !== expectedStatus ||
				!('intentKey' in slot) ||
				slot.intentKey !== event.details.intentKey
			) {
				return 'MessageSettled event does not agree with the snapshot'
			}
		}
		if (event.type === 'JourneyExited') {
			if (
				!('exit' in candidate.decision.next) ||
				candidate.decision.next.exit.type !== event.details.reason
			) {
				return 'JourneyExited event does not agree with the snapshot'
			}
		}
	}
	return null
}

function allMessageSlots(aggregate: EvergreenOfferJourneyAggregate) {
	return [...aggregate.messagePlan.bridge, ...aggregate.messagePlan.pitch]
}

function constraintFailure(
	candidate: JourneyLedgerCommit,
	reason: string,
): Extract<JourneyCommandError, { type: 'JourneyConstraintViolation' }> {
	return {
		type: 'JourneyConstraintViolation',
		journeyId: candidate.decision.next.journeyId,
		reason,
	}
}
