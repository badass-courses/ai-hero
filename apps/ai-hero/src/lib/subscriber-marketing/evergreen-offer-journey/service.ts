import { Effect, Either } from 'effect'

import { decideEvergreenOfferJourney } from './decision'
import type { EvergreenOfferJourneyDefinition } from './domain'
import {
	restoreEvergreenOfferAuthority,
	restoreEvergreenOfferStimulus,
} from './persistence-codec'
import type {
	EvergreenOfferJourneyService,
	JourneyClock,
	JourneyLedger,
	OfferAuthority,
} from './ports'
import { deriveJourneyId } from './primitives'

/**
 * Commits decisions and their operational receipts, never provider work.
 * OfferAuthority owns current purchase, delivery and automation-control reads.
 * Missing control is an invalid authority response and fails closed.
 * Returned decisions, including replayed intents, are historical evidence.
 * Never execute effects from this return value. Execute only through durable
 * outbox claims with current authority checked immediately before application.
 */
export function createEvergreenOfferJourneyService(dependencies: {
	readonly ledger: JourneyLedger
	readonly authority: OfferAuthority
	readonly clock: JourneyClock
	readonly definition: EvergreenOfferJourneyDefinition
}): EvergreenOfferJourneyService {
	const { ledger, authority, clock } = dependencies
	const definition = structuredClone(dependencies.definition)

	const readAuthority: OfferAuthority['currentFacts'] = (query) =>
		Effect.gen(function* () {
			const response = yield* authority.currentFacts(query)
			const restored = restoreEvergreenOfferAuthority(response)
			if (!restored.ok)
				return yield* Effect.fail({
					type: 'AuthorityInconsistent' as const,
					reason: restored.error.reason,
				})
			if (
				restored.value.contactId !== query.contactId ||
				(query.journeyId !== null &&
					restored.value.existingJourneyId !== query.journeyId)
			) {
				return yield* Effect.fail({
					type: 'AuthorityInconsistent' as const,
					reason: 'Current authority belongs to another contact or journey',
				})
			}
			return restored.value
		})
	const readClock = clock.now.pipe(
		Effect.mapError((error) => ({
			type: 'AuthorityUnavailable' as const,
			reason: `Clock unavailable: ${error.reason}`,
		})),
	)

	const advance: EvergreenOfferJourneyService['advance'] = (input) => {
		// Decode and detach at the public boundary, before a caller can mutate a
		// stimulus while an authority/ledger read is suspended.
		const decoded = restoreEvergreenOfferStimulus(input)
		if (!decoded.ok)
			return Effect.fail({
				type: 'JourneyDecodeFailure',
				reason: decoded.error.reason,
			})
		const stimulus = decoded.value
		if (
			stimulus.type === 'CourseSequenceExhausted' &&
			String(stimulus.stimulusId) !== String(stimulus.entryFactId)
		) {
			return Effect.fail({
				type: 'JourneyDecodeFailure',
				reason: 'Entry stimulus must use the committed ContactEvent ID',
			})
		}
		const journeyId =
			stimulus.type === 'CourseSequenceExhausted'
				? deriveJourneyId(stimulus.entryFactId)
				: stimulus.journeyId
		return Effect.gen(function* () {
			for (let attempt = 0; attempt < 3; attempt++) {
				const replay = yield* ledger.findCommittedStimulus(
					stimulus.stimulusId,
					stimulus,
				)
				if (replay)
					return { ...replay, committed: false, replayedStimulus: true }
				const snapshot = yield* ledger.load(journeyId)
				const contactId =
					stimulus.type === 'CourseSequenceExhausted'
						? stimulus.contactId
						: snapshot?.contactId
				if (!contactId)
					return yield* Effect.fail({
						type: 'JourneyDecodeFailure' as const,
						reason: 'Journey does not exist',
					})
				const currentFacts = yield* readAuthority({
					contactId,
					journeyId: snapshot?.journeyId ?? null,
				})
				const now = yield* readClock
				const result = decideEvergreenOfferJourney({
					snapshot,
					stimulus,
					currentFacts,
					definition,
					now,
				})
				if (!result.ok)
					return yield* Effect.fail({
						type: 'JourneyDecisionFailure' as const,
						reason: result.error.reason,
					})
				if (result.decision.type === 'Ignored')
					return {
						decision: result.decision,
						committed: false,
						replayedStimulus: false,
					}
				const committed = yield* Effect.either(
					ledger.commit({
						stimulus,
						expectedVersion: snapshot?.version ?? null,
						currentFacts,
						definition: snapshot?.definition ?? definition,
						decidedAt: now,
						decision: result.decision,
					}),
				)
				if (Either.isRight(committed)) return committed.right
				if (committed.left.type !== 'JourneyVersionConflict' || attempt === 2)
					return yield* Effect.fail(committed.left)
				// Re-read both the aggregate and current authority after a CAS race.
				// Never resubmit a decision made from stale purchase/control evidence.
			}
			return yield* Effect.fail({
				type: 'JourneyVersionConflict' as const,
				journeyId,
			})
		})
	}
	const inspect: EvergreenOfferJourneyService['inspect'] = (journeyId) =>
		Effect.gen(function* () {
			const snapshot = yield* ledger.load(journeyId)
			if (!snapshot)
				return yield* Effect.fail({
					type: 'JourneyNotFound' as const,
					journeyId,
				})
			const currentFacts = yield* readAuthority({
				contactId: snapshot.contactId,
				journeyId,
			})
			const now = yield* readClock
			return yield* ledger.inspect({
				journeyId,
				now,
				automationControl: currentFacts.automationControl.type,
			})
		}).pipe(
			Effect.mapError((error) =>
				error.type === 'JourneyNotFound' ||
				error.type === 'JourneyDecodeFailure' ||
				error.type === 'JourneyQueryUnavailable'
					? error
					: {
							type: 'JourneyQueryUnavailable' as const,
							reason:
								'reason' in error
									? `${error.type}: ${error.reason}`
									: error.type,
						},
			),
		)
	return { advance, inspect }
}
