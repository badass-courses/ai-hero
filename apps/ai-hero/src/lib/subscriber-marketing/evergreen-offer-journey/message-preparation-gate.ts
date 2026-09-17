import { createActor } from 'xstate'
import type { SendMessageIntent } from './domain'
import type { AttemptEvidence } from './attempt-evidence'
import {
	preparationMachine,
	preparationSnapshotSchema,
	type MessagePreparationSnapshot,
} from './message-preparation'
import type { MessageFieldsTransport } from './message-preparation-fields'
import type { MessagePreparationStore } from './message-preparation-store'

export type MessagePreparationGate = {
	prepare(
		intent: SendMessageIntent,
		evidence: AttemptEvidence,
	): Promise<
		| { type: 'Ready'; snapshot: MessagePreparationSnapshot }
		| { type: 'Held'; reason: string; fieldsRequest: 'none' | 'possible' }
	>
	reserveEnrollment(snapshot: MessagePreparationSnapshot): Promise<boolean>
	identity(
		intent: SendMessageIntent,
	): Promise<{ subscriberId: number; email: string } | null>
	mayReconcile(intent: SendMessageIntent): Promise<boolean>
}
export function preparationMatchesIntent(
	s: MessagePreparationSnapshot,
	i: SendMessageIntent,
) {
	return (
		s.intentKey === i.idempotencyKey &&
		s.contactId === i.contactId &&
		s.journeyId === i.journeyId &&
		s.slot === i.slotId &&
		s.notBefore === i.notBefore &&
		s.notAfter === i.notAfter
	)
}
/** Preparation does not send. The owning executor records original mapping first,
 * then prepares/reserves, then repeats its fresh control/window/revision/lease
 * checks before the existing enrollment adapter. All HTTP is outside DB locks. */
export function createMessagePreparationGate(options: {
	store: MessagePreparationStore
	fields: MessageFieldsTransport
	build: (
		intent: SendMessageIntent,
		evidence: AttemptEvidence,
	) => Promise<MessagePreparationSnapshot>
	current: (
		snapshot: MessagePreparationSnapshot,
		intent: SendMessageIntent,
	) => Promise<boolean>
}): MessagePreparationGate {
	const confirmed = new WeakSet<MessagePreparationSnapshot>()
	return {
		async prepare(intent, evidence) {
			const machine = createActor(preparationMachine).start()
			let fieldsRequest: 'none' | 'possible' = 'none'
			const held = (reason: string) => {
				machine.send({ type: 'HOLD' })
				return { type: 'Held' as const, reason, fieldsRequest }
			}
			try {
				const candidate = preparationSnapshotSchema.parse(
					await options.build(intent, evidence),
				)
				if (
					!preparationMatchesIntent(candidate, intent) ||
					candidate.claimToken !== evidence.claimToken ||
					candidate.claimedAt !== evidence.claimedAt.toISOString()
				)
					return held('PreparationIntentMismatch')
				const snapshot = await options.store.freeze(candidate)
				if (!snapshot) return held('PreparationSnapshotUnconfirmed')
				machine.send({ type: 'SNAPSHOT' })
				if (await options.store.read(snapshot, 'enrollment-requested'))
					return held('EnrollmentAlreadyReserved')
				const claim = await options.store.claim(snapshot, 'fields-requested')
				if (claim === 'Unknown') return held('FieldRequestOwnershipUnknown')
				fieldsRequest = 'possible'
				machine.send({ type: 'FIELDS' })
				if (claim === 'Claimed') await options.fields.project(snapshot)
				// Existing/uncertain projection is GET-only: never blindly repeat PUT.
				if (!(await options.fields.confirm(snapshot)))
					return held('FieldProjectionUnconfirmed')
				if (!(await options.current(snapshot, intent)))
					return held('PreparationAuthorityChanged')
				if (
					!(await options.store.read(snapshot, 'snapshot')) ||
					!(await options.store.read(snapshot, 'namespace'))
				)
					return held('PreparationReadbackChanged')
				machine.send({ type: 'READBACK' })
				if (machine.getSnapshot().value !== 'confirmed')
					return held('InvalidPreparationPhase')
				confirmed.add(snapshot)
				return { type: 'Ready', snapshot }
			} catch {
				return held('PreparationUnavailable')
			} finally {
				machine.stop()
			}
		},
		async reserveEnrollment(snapshot) {
			// This is a MAY-have-issued marker, not evidence of a request or delivery.
			if (!confirmed.has(snapshot)) return false
			confirmed.delete(snapshot)
			return (
				(await options.store.claim(snapshot, 'enrollment-requested')) ===
				'Claimed'
			)
		},
		async identity(intent) {
			const s = await options.store.find(intent.idempotencyKey)
			return s &&
				preparationMatchesIntent(s, intent) &&
				(await options.store.read(s, 'namespace')) &&
				(await options.store.read(s, 'enrollment-requested')) &&
				(await options.fields.confirm(s))
				? { subscriberId: s.subscriberId, email: s.email }
				: null
		},
		async mayReconcile(intent) {
			try {
				const snapshot = await options.store.find(intent.idempotencyKey)
				return Boolean(
					snapshot &&
					preparationMatchesIntent(snapshot, intent) &&
					(await options.store.read(snapshot, 'namespace')) &&
					(await options.store.read(snapshot, 'enrollment-requested')),
				)
			} catch {
				return false
			}
		},
	}
}
