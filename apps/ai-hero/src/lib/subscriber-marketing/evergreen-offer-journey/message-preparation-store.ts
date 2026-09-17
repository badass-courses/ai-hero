import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { contactEvent } from '@/db/schema'
import type { EvergreenOfferJourneyDatabase } from './drizzle-ledger'
import {
	MESSAGE_PREPARATION_EVENT,
	preparationEventSchema,
	preparationKey,
	preparationHash,
	preparationSnapshotSchema,
	type MessagePreparationSnapshot,
	type PreparationStage,
} from './message-preparation'

export function preparationEventId(
	snapshot: MessagePreparationSnapshot,
	stage: PreparationStage,
) {
	return `emp_${stage === 'namespace' ? preparationKey(snapshot) : preparationHash(JSON.stringify(['message-preparation-intent', snapshot.intentKey]))}_${stage}`
}
export function preparationEventRow(input: unknown) {
	const p = preparationEventSchema.parse(input),
		s = p.snapshot,
		id = preparationEventId(s, p.stage)
	return {
		id,
		contactId: s.contactId,
		providerIdentityId: s.providerIdentityId,
		provider: 'ai-hero',
		providerEventId: id,
		providerReference: `message-preparation:${s.namespace}:${s.subscriberId}`,
		eventType: MESSAGE_PREPARATION_EVENT,
		semanticIdempotencyKey: id,
		privacyLevel: 'restricted',
		identityEvidence: {
			type: 'immutable-message-preparation',
			contactId: s.contactId,
			providerIdentityId: s.providerIdentityId,
			subscriberId: s.subscriberId,
		},
		payloadSummary: p,
		schemaVersion: 1,
		occurredAt: new Date(Math.floor(Date.parse(p.observedAt) / 1000) * 1000),
	}
}
/** Exact internal envelope, not a prefix/event-name exemption. Accept Date or
 * the operator repository's ISO string projection, never a repaired envelope. */
export function decodePreparationEvent(row: Record<string, unknown>) {
	try {
		const p = preparationEventSchema.parse(row.payloadSummary),
			expected = preparationEventRow(p)
		for (const [key, value] of Object.entries(expected)) {
			if (key === 'occurredAt') {
				const actual =
					row[key] instanceof Date ? row[key] : new Date(String(row[key]))
				if (!isDeepStrictEqual(actual, value)) return null
			} else if (!isDeepStrictEqual(row[key], value)) return null
		}
		return p
	} catch {
		return null
	}
}
export type MessagePreparationStore = {
	find(intentKey: string): Promise<MessagePreparationSnapshot | null>
	freeze(
		snapshot: MessagePreparationSnapshot,
	): Promise<MessagePreparationSnapshot | null>
	read(
		snapshot: MessagePreparationSnapshot,
		stage: PreparationStage,
	): Promise<boolean>
	claim(
		snapshot: MessagePreparationSnapshot,
		stage: Exclude<PreparationStage, 'snapshot' | 'namespace'>,
	): Promise<'Claimed' | 'Exists' | 'Unknown'>
}
/** Separate readback handle is mandatory. No network, broad transaction, UPDATE,
 * overwrite or lease acquisition. Unknown INSERT never grants effect ownership. */
export function createMySqlMessagePreparationStore(options: {
	database: Pick<EvergreenOfferJourneyDatabase, 'insert'>
	readback: Pick<EvergreenOfferJourneyDatabase, 'select'>
	now: () => string
}): MessagePreparationStore {
	const get = async (
		snapshot: MessagePreparationSnapshot,
		stage: PreparationStage,
	) => {
		const [row] = await options.readback
			.select()
			.from(contactEvent)
			.where(eq(contactEvent.id, preparationEventId(snapshot, stage)))
			.limit(1)
		return row ? decodePreparationEvent(row) : null
	}
	return {
		async find(intentKey) {
			try {
				const id = `emp_${preparationHash(JSON.stringify(['message-preparation-intent', intentKey]))}_snapshot`
				const [row] = await options.readback
					.select()
					.from(contactEvent)
					.where(eq(contactEvent.id, id))
					.limit(1)
				const p = row ? decodePreparationEvent(row) : null
				return p?.stage === 'snapshot' && p.snapshot.intentKey === intentKey
					? p.snapshot
					: null
			} catch {
				return null
			}
		},
		async freeze(input) {
			try {
				const candidate = preparationSnapshotSchema.parse(input)
				const prior = await get(candidate, 'snapshot')
				if (!prior) {
					const row = preparationEventRow({
						version: 1,
						stage: 'snapshot',
						observedAt: candidate.preparedAt,
						snapshot: candidate,
					})
					try {
						await options.database.insert(contactEvent).values(row)
					} catch {
						/* Independent committed readback, never rewrite. */
					}
				}
				const actual = prior ?? (await get(candidate, 'snapshot'))
				if (
					!actual ||
					!isDeepStrictEqual(
						{ ...candidate, preparedAt: actual.snapshot.preparedAt },
						actual.snapshot,
					)
				)
					return null
				// A second immutable uniqueness anchor protects the subscriber/slot namespace
				// across different contacts, journeys and attempts. Partial anchors only hold.
				const frozen = actual.snapshot
				if (!(await get(frozen, 'namespace'))) {
					try {
						await options.database
							.insert(contactEvent)
							.values(
								preparationEventRow({
									version: 1,
									stage: 'namespace',
									observedAt: frozen.preparedAt,
									snapshot: frozen,
								}),
							)
					} catch {
						/* Read back the winning anchor. */
					}
				}
				const namespace = await get(frozen, 'namespace')
				return namespace && isDeepStrictEqual(namespace.snapshot, frozen)
					? frozen
					: null
			} catch {
				return null
			}
		},
		async read(snapshot, stage) {
			try {
				const p = await get(snapshot, stage)
				return Boolean(
					p && p.stage === stage && isDeepStrictEqual(p.snapshot, snapshot),
				)
			} catch {
				return false
			}
		},
		async claim(snapshot, stage) {
			try {
				if (
					!(await this.read(snapshot, 'snapshot')) ||
					!(await this.read(snapshot, 'namespace'))
				)
					return 'Unknown'
				if (
					stage === 'enrollment-requested' &&
					!(await this.read(snapshot, 'fields-requested'))
				)
					return 'Unknown'
				const prior = await get(snapshot, stage)
				if (prior)
					return isDeepStrictEqual(prior.snapshot, snapshot)
						? 'Exists'
						: 'Unknown'
				const row = preparationEventRow({
					version: 1,
					stage,
					observedAt: options.now(),
					snapshot,
				})
				let acknowledged = false
				try {
					await options.database.insert(contactEvent).values(row)
					acknowledged = true
				} catch {
					/* A timeout could have committed. Do not issue an effect. */
				}
				const read = await get(snapshot, stage)
				if (!read || !isDeepStrictEqual(read.snapshot, snapshot))
					return 'Unknown'
				return acknowledged && isDeepStrictEqual(read, row.payloadSummary)
					? 'Claimed'
					: 'Exists'
			} catch {
				return 'Unknown'
			}
		},
	}
}
