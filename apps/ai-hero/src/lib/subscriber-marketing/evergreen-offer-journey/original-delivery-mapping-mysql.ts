import { isDeepStrictEqual } from 'node:util'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { contactEvent, providerIdentity } from '@/db/schema'
import {
	evergreenOfferJourneyAttempt as attempts,
	evergreenOfferJourneyIntent as intents,
} from '@/db/evergreen-offer-journey-schema'
import {
	createDrizzleJourneyLedger,
	readCanonicalIntentOrigin,
	type EvergreenOfferJourneyDatabase,
} from './drizzle-ledger'
import { decodeAttempt, type AttemptEvidence } from './attempt-evidence'
import type {
	EvergreenOfferJourneyAggregate,
	SideEffectIntent,
	SendMessageIntent,
} from './domain'
import {
	captureRevisionScope,
	type DeliveryRevisionScopeData,
	type OriginalDeliveryMappingReader,
	type OriginalDeliveryMappingWriter,
	type MappingRecordResult,
} from './revision-scope'
import {
	mappingCoreSchema,
	mappingEventRow,
	mappingIdentity,
	mappingReceipt,
	readMappingEventRow,
	sameMappingSelection,
	type OriginalMappingCore,
	type MappingSource,
} from './original-delivery-mapping'
import { parseIsoInstant, parseJourneyId } from './primitives'

export interface OriginalMappingPersistence {
	readonly attempt: (key: string) => Promise<unknown | null>
	readonly canonical: (
		key: string,
		journeyId: string,
	) => Promise<{
		intent: SideEffectIntent
		aggregate: EvergreenOfferJourneyAggregate
	} | null>
	readonly event: (
		id: string,
	) => Promise<typeof contactEvent.$inferSelect | null>
	readonly identity: (
		id: string,
	) => Promise<typeof providerIdentity.$inferSelect | null>
	readonly insert: (row: ReturnType<typeof mappingEventRow>) => Promise<void>
}
export type MappingReadFailure = {
	readonly type: 'MappingUnavailable' | 'MappingConflict'
	readonly detail: string
}
class MappingHold extends Error {
	constructor(
		readonly type: MappingReadFailure['type'],
		readonly detail: string,
	) {
		super(detail)
	}
}
const unavailable = (detail: string): never => {
	throw new MappingHold('MappingUnavailable', detail)
}
const conflict = (detail: string): never => {
	throw new MappingHold('MappingConflict', detail)
}
const failure = (error: unknown): MappingReadFailure =>
	error instanceof MappingHold
		? { type: error.type, detail: error.detail }
		: { type: 'MappingUnavailable', detail: 'Mapping store unavailable' }

/** Writer handle must be a primary/autocommit database, not a transaction or replica.
 * No global client, credentials, NOW(), capture pipeline, upsert or retry. */
export function createMySqlOriginalMappingPersistence(
	database: EvergreenOfferJourneyDatabase,
): OriginalMappingPersistence {
	const ledger = createDrizzleJourneyLedger(database)
	return {
		attempt: async (key) =>
			(
				await database
					.select()
					.from(attempts)
					.where(eq(attempts.idempotencyKey, key))
					.limit(1)
			)[0] ?? null,
		canonical: async (key, journeyId) => {
			const row = (
				await database
					.select()
					.from(intents)
					.where(eq(intents.idempotencyKey, key))
					.limit(1)
			)[0]
			if (!row || row.journeyId !== journeyId) return null
			const origin = await Effect.runPromise(
				readCanonicalIntentOrigin(database, row),
			)
			const parsed = parseJourneyId(journeyId)
			if (!parsed.ok) return null
			const aggregate = await Effect.runPromise(ledger.load(parsed.value))
			return aggregate ? { intent: origin.intent, aggregate } : null
		},
		event: async (id) =>
			(
				await database
					.select()
					.from(contactEvent)
					.where(eq(contactEvent.id, id))
					.limit(1)
			)[0] ?? null,
		identity: async (id) =>
			(
				await database
					.select()
					.from(providerIdentity)
					.where(eq(providerIdentity.id, id))
					.limit(1)
			)[0] ?? null,
		insert: async (row) => {
			await database.insert(contactEvent).values(row)
		},
	}
}
/** Separate capabilities: historical reader never invokes insert or the live writer.
 * Stored selected configuration is NOT proof of request, provider causality or body approval. */
export function createOriginalDeliveryMapping(options: {
	store: OriginalMappingPersistence
	now: () => string
}): {
	writer: OriginalDeliveryMappingWriter
	reader: OriginalDeliveryMappingReader
} {
	const store = options.store
	function now() {
		const value = options.now()
		const parsed = parseIsoInstant(value)
		if (!parsed.ok || parsed.value !== value)
			return unavailable('Mapping clock invalid')
		return value
	}
	async function context(supplied: Readonly<AttemptEvidence>, live: boolean) {
		const query = decodeAttempt(supplied)
		const raw = await store.attempt(query.idempotencyKey)
		if (!raw) return unavailable('AttemptMissing')
		const actual = decodeAttempt(raw)
		if (
			actual.journeyId !== query.journeyId ||
			actual.idempotencyKey !== query.idempotencyKey ||
			actual.claimToken !== query.claimToken ||
			actual.claimedAt.getTime() !== query.claimedAt.getTime() ||
			actual.leaseExpiresAt.getTime() !== query.leaseExpiresAt.getTime()
		)
			return conflict('AttemptMismatch')
		const canonical = await store.canonical(
			query.idempotencyKey,
			query.journeyId,
		)
		if (!canonical) return unavailable('CanonicalIntentMissing')
		const { intent, aggregate } = canonical
		if (
			intent.type !== 'SendMessage' ||
			intent.idempotencyKey !== actual.idempotencyKey ||
			intent.journeyId !== actual.journeyId ||
			aggregate.journeyId !== actual.journeyId ||
			intent.contactId !== aggregate.contactId
		)
			return conflict('CanonicalIntentMismatch')
		const source = await store.event(aggregate.entryFactId)
		if (!source) return unavailable('SourceEventMissing')
		if (
			source.id !== aggregate.entryFactId ||
			source.eventType !== 'course.sequence-exhausted' ||
			source.contactId !== aggregate.contactId
		)
			return conflict('SourceEventMismatch')
		const identity = await store.identity(source.providerIdentityId)
		if (!identity) return unavailable('ProviderIdentityMissing')
		if (
			identity.id !== source.providerIdentityId ||
			identity.contactId !== aggregate.contactId
		)
			return conflict('ProviderIdentityMismatch')
		const at = now()
		if (
			live &&
			(actual.status !== 'Claimed' ||
				actual.claimedAt > new Date(at) ||
				actual.leaseExpiresAt <= new Date(at))
		)
			return conflict('ClaimNotLive')
		return {
			actual,
			intent,
			aggregate,
			at,
			source: {
				sourceEventId: source.id,
				providerIdentityId: identity.id,
			} satisfies MappingSource,
		}
	}
	function validateStored(
		row: unknown,
		c: Awaited<ReturnType<typeof context>>,
	) {
		let core: OriginalMappingCore
		try {
			core = readMappingEventRow(row, c.source)
		} catch {
			return conflict('MappingEnvelopeInvalid')
		}
		const { intent, aggregate, actual } = c
		if (
			core.journeyId !== actual.journeyId ||
			core.idempotencyKey !== actual.idempotencyKey ||
			core.claimToken !== actual.claimToken ||
			core.contactId !== aggregate.contactId ||
			core.slotId !== intent.slotId ||
			core.contentResourceId !== intent.contentResourceId ||
			!isDeepStrictEqual(core.presentation, intent.presentation) ||
			!isDeepStrictEqual(core.revision, {
				definitionVersion: aggregate.definition.definitionVersion,
				messagePlanId: aggregate.definition.messagePlanId,
				contentRevision: aggregate.definition.contentRevision,
				messagePlanSourceHash: aggregate.definition.messagePlanSourceHash,
				presentationReviewRevision:
					aggregate.definition.presentationReviewRevision,
			}) ||
			new Date(core.recordedAt) < actual.claimedAt ||
			new Date(core.recordedAt) >= actual.leaseExpiresAt ||
			core.recordedAt > now()
		)
			return conflict('MappingCoreMismatch')
		return core
	}
	function selected(
		input: {
			intent: Readonly<SendMessageIntent>
			manifest: DeliveryRevisionScopeData
		},
		c: Awaited<ReturnType<typeof context>>,
	) {
		if (!isDeepStrictEqual(input.intent, c.intent))
			return conflict('SuppliedIntentMismatch')
		const scope = captureRevisionScope({
			manifest: input.manifest,
			originalMapping: null,
		})
		if (scope.check(c.aggregate, c.intent) || !scope.manifest)
			return conflict('MappingScopeMismatch')
		const message = scope.manifest.messages.find(
			(m) => m.slotId === c.intent.slotId,
		)
		if (!message) return conflict('SelectedMappingMissing')
		return mappingCoreSchema.parse({
			format: 'evergreen.delivery-mapping-record.v1',
			contactId: c.intent.contactId,
			journeyId: c.intent.journeyId,
			idempotencyKey: c.intent.idempotencyKey,
			claimToken: c.actual.claimToken,
			slotId: c.intent.slotId,
			contentResourceId: c.intent.contentResourceId,
			presentation: c.intent.presentation,
			revision: scope.manifest.revision,
			bindingArtifactSha256: scope.manifest.bindingArtifactSha256,
			bindingEvidenceId: scope.manifest.bindingEvidenceId,
			bodySha256: message.bodySha256,
			sequenceId: message.sequenceId,
			recordedAt: c.at,
		})
	}
	const writer: OriginalDeliveryMappingWriter = {
		record: (input) =>
			Effect.promise(async (): Promise<MappingRecordResult> => {
				let sideEffects:
					| 'none'
					| 'mapping-may-have-persisted'
					| 'mapping-persisted' = 'none'
				try {
					const c = await context(input.attempt, true)
					const proposed = selected(input, c)
					const row = mappingEventRow(proposed, c.source)
					// Autocommit INSERT; unique keys arbitrate concurrent writers. Every outcome,
					// including duplicate or ambiguous acknowledgment, gets ONE fresh verification.
					sideEffects = 'mapping-may-have-persisted'
					let insertOutcome: 'inserted' | 'duplicate' | 'ambiguous' = 'inserted'
					try {
						await store.insert(row)
					} catch (error) {
						insertOutcome =
							error &&
							typeof error === 'object' &&
							'code' in error &&
							error.code === 'ER_DUP_ENTRY'
								? 'duplicate'
								: 'ambiguous'
					}
					const stored = await store.event(row.id)
					if (!stored) return unavailable('MappingReadbackMissing')
					const core = validateStored(stored, c)
					if (
						!sameMappingSelection(core, proposed) ||
						(insertOutcome === 'inserted' &&
							core.recordedAt !== proposed.recordedAt)
					)
						return conflict('MappingSelectionConflict')
					sideEffects = 'mapping-persisted'
					// Receipt latency may outlive the claim. Preserve row, but do not authorize apply.
					const fresh = await context(input.attempt, true)
					if (
						!isDeepStrictEqual(c.intent, fresh.intent) ||
						!isDeepStrictEqual(c.source, fresh.source)
					)
						return conflict('MappingContextChanged')
					selected(input, fresh)
					return { type: 'Verified', receipt: mappingReceipt(core) }
				} catch (error) {
					const f = failure(error)
					return {
						type: 'Held',
						reason: f.type,
						detail: f.detail,
						sideEffects,
					}
				}
			}),
	}
	const reader: OriginalDeliveryMappingReader = {
		read: (attempt) =>
			Effect.tryPromise({
				try: async () => {
					const c = await context(attempt, false)
					const row = await store.event(mappingIdentity(c.actual).id)
					if (!row) return unavailable('MappingMissing')
					return mappingReceipt(validateStored(row, c))
				},
				catch: failure,
			}),
	}
	return { writer, reader }
}
