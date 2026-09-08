import { isDeepStrictEqual } from 'node:util'
import { Effect } from 'effect'
import { z } from 'zod'
import type { AttemptEvidence } from './attempt-evidence'
import type {
	EvergreenOfferJourneyAggregate,
	SendMessageIntent,
} from './domain'

const nonblank = z.string().trim().min(1)
const sha = z.string().regex(/^[0-9a-f]{64}$/)
export const deliveryRevisionSchema = z
	.object({
		definitionVersion: nonblank,
		messagePlanId: nonblank,
		contentRevision: nonblank,
		messagePlanSourceHash: sha,
		presentationReviewRevision: nonblank,
	})
	.strict()
export type DeliveryRevision = z.infer<typeof deliveryRevisionSchema>
const selection = z
	.object({
		bundleId: nonblank,
		subjectId: nonblank,
		headlineId: nonblank,
		openingId: nonblank,
		ctaId: nonblank,
	})
	.strict()
export const revisionManifestSchema = z
	.array(
		z
			.object({
				slotId: nonblank,
				contentResourceId: nonblank,
				presentation: selection,
				bodySha256: sha,
				sequenceId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			})
			.strict(),
	)
	.length(8)
export const revisionScopeDataSchema = z
	.object({
		revision: deliveryRevisionSchema,
		bindingArtifactSha256: sha,
		bindingEvidenceId: nonblank,
		messages: revisionManifestSchema,
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const key of ['slotId', 'contentResourceId', 'sequenceId'] as const)
			if (new Set(value.messages.map((m) => m[key])).size !== 8)
				ctx.addIssue({ code: 'custom', message: `Duplicate ${key}` })
	})
export type DeliveryRevisionScopeData = z.infer<typeof revisionScopeDataSchema>

/** Trusted external receipt boundary, not today's registry as historical proof.
 * An implementation must read immutable original-mapping evidence, not synthesize
 * this record from its query. No production implementation or receipt writer here.
 */
export const originalMappingSchema = z
	.object({
		format: z.literal('original-delivery-mapping.v1'),
		sourceReceiptSha256: sha,
		sourceReference: nonblank,
		journeyId: nonblank,
		idempotencyKey: nonblank,
		claimToken: z.string().uuid(),
		revision: deliveryRevisionSchema,
		bindingArtifactSha256: sha,
		bindingEvidenceId: nonblank,
		contentResourceId: nonblank,
		bodySha256: sha,
		sequenceId: z.number().int().positive(),
	})
	.strict()
export interface OriginalDeliveryMappingReader {
	readonly read: (
		attempt: Readonly<AttemptEvidence>,
	) => Effect.Effect<unknown, unknown>
}
export type MappingRecordResult =
	| { readonly type: 'Verified'; readonly receipt: unknown }
	| {
			readonly type: 'Held'
			readonly reason: 'MappingUnavailable' | 'MappingConflict'
			readonly detail: string
			readonly sideEffects:
				| 'none'
				| 'mapping-may-have-persisted'
				| 'mapping-persisted'
	  }
export interface OriginalDeliveryMappingWriter {
	readonly record: (input: {
		readonly attempt: Readonly<AttemptEvidence>
		readonly intent: Readonly<SendMessageIntent>
		readonly manifest: DeliveryRevisionScopeData
	}) => Effect.Effect<MappingRecordResult, unknown>
}
export type DeliveryRevisionScope = {
	readonly manifest: DeliveryRevisionScopeData
	/** Explicit null is fail-closed, not permission to assume current mapping. */
	readonly originalMapping: OriginalDeliveryMappingReader | null
	/** Missing writer disables live execution, never read-only recovery. */
	readonly mappingWriter?: OriginalDeliveryMappingWriter | null
}
export type RevisionHoldReason =
	| 'RevisionUnavailable'
	| 'RevisionMismatch'
	| 'OriginalMappingUnavailable'
export function freezeRevision<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) freezeRevision(child)
		Object.freeze(value)
	}
	return value
}
export function revisionOf(value: DeliveryRevision): DeliveryRevision {
	return {
		definitionVersion: value.definitionVersion,
		messagePlanId: value.messagePlanId,
		contentRevision: value.contentRevision,
		messagePlanSourceHash: value.messagePlanSourceHash,
		presentationReviewRevision: value.presentationReviewRevision,
	}
}
export function captureRevisionScope(scope: DeliveryRevisionScope) {
	const decoded = revisionScopeDataSchema.safeParse(scope?.manifest)
	const manifest = decoded.success ? freezeRevision(decoded.data) : null
	const read = scope?.originalMapping?.read
	const writer =
		typeof scope?.mappingWriter?.record === 'function'
			? scope.mappingWriter.record.bind(scope.mappingWriter)
			: null
	function agrees(
		raw: unknown,
		attempt: AttemptEvidence,
		intent: SendMessageIntent,
	) {
		const parsed = originalMappingSchema.safeParse(raw)
		if (!manifest || !parsed.success) return false
		const p = parsed.data
		const selected = manifest.messages.find((m) => m.slotId === intent.slotId)
		return (
			!!selected &&
			p.journeyId === attempt.journeyId &&
			p.idempotencyKey === attempt.idempotencyKey &&
			p.claimToken === attempt.claimToken &&
			p.bindingArtifactSha256 === manifest.bindingArtifactSha256 &&
			p.bindingEvidenceId === manifest.bindingEvidenceId &&
			isDeepStrictEqual(p.revision, manifest.revision) &&
			p.contentResourceId === intent.contentResourceId &&
			p.sequenceId === selected.sequenceId &&
			p.bodySha256 === selected.bodySha256
		)
	}
	function record(attempt: AttemptEvidence, intent: SendMessageIntent) {
		return Effect.gen(function* () {
			if (!manifest || !writer)
				return {
					type: 'Held',
					reason: 'MappingUnavailable',
					detail: 'Mapping writer unconfigured',
					sideEffects: 'none',
				} as const
			const result = yield* writer({
				attempt: freezeRevision(structuredClone(attempt)),
				intent: freezeRevision(structuredClone(intent)),
				manifest,
			})
			if (result.type === 'Held') return result
			if (!agrees(result.receipt, attempt, intent))
				return {
					type: 'Held',
					reason: 'MappingConflict',
					detail: 'Recorded mapping disagrees with captured scope',
					sideEffects: 'mapping-may-have-persisted',
				} as const
			return {
				type: 'Verified',
				receipt: originalMappingSchema.parse(result.receipt),
			} as const
		}).pipe(
			Effect.catchAllCause(() =>
				Effect.succeed({
					type: 'Held',
					reason: 'MappingUnavailable',
					detail: 'Mapping writer unavailable',
					sideEffects: 'mapping-may-have-persisted',
				} as const),
			),
		)
	}
	function check(
		aggregate: EvergreenOfferJourneyAggregate,
		intent: SendMessageIntent,
	): RevisionHoldReason | null {
		if (!manifest) return 'RevisionUnavailable'
		if (
			!isDeepStrictEqual(revisionOf(aggregate.definition), manifest.revision) ||
			!isDeepStrictEqual(revisionOf(aggregate.messagePlan), manifest.revision)
		)
			return 'RevisionMismatch'
		const definitions = [
			...aggregate.definition.bridge,
			...aggregate.definition.pitch,
		]
		if (
			definitions.length !== 8 ||
			definitions.some(
				(d) =>
					!manifest.messages.some(
						(m) =>
							m.slotId === d.slotId &&
							m.contentResourceId === d.contentResourceId &&
							isDeepStrictEqual(m.presentation, d.presentation),
					),
			)
		)
			return 'RevisionMismatch'
		const selected = manifest.messages.find((m) => m.slotId === intent.slotId)
		const slot = [
			...aggregate.messagePlan.bridge,
			...aggregate.messagePlan.pitch,
		].find((s) => s.slotId === intent.slotId)
		if (
			!selected ||
			!slot ||
			aggregate.journeyId !== intent.journeyId ||
			aggregate.contactId !== intent.contactId ||
			selected.contentResourceId !== intent.contentResourceId ||
			!isDeepStrictEqual(selected.presentation, intent.presentation) ||
			!isDeepStrictEqual(slot.presentation, intent.presentation)
		)
			return 'RevisionMismatch'
		return null
	}
	function original(attempt: AttemptEvidence, intent: SendMessageIntent) {
		return Effect.gen(function* () {
			if (
				!manifest ||
				!read ||
				intent.journeyId !== attempt.journeyId ||
				intent.idempotencyKey !== attempt.idempotencyKey
			)
				return false
			const raw = yield* read(freezeRevision(structuredClone(attempt)))
			const parsed = originalMappingSchema.safeParse(raw)
			if (!parsed.success) return false
			const p = parsed.data
			const selected = manifest.messages.find((m) => m.slotId === intent.slotId)
			return (
				!!selected &&
				p.journeyId === attempt.journeyId &&
				p.idempotencyKey === attempt.idempotencyKey &&
				p.claimToken === attempt.claimToken &&
				p.bindingArtifactSha256 === manifest.bindingArtifactSha256 &&
				p.bindingEvidenceId === manifest.bindingEvidenceId &&
				isDeepStrictEqual(p.revision, manifest.revision) &&
				p.contentResourceId === intent.contentResourceId &&
				p.sequenceId === selected.sequenceId &&
				p.bodySha256 === selected.bodySha256
			)
		}).pipe(Effect.catchAllCause(() => Effect.succeed(false)))
	}
	return { manifest, check, original, record, hasWriter: !!writer }
}
