import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { deliveryRevisionSchema } from './revision-scope'

const id = z
	.string()
	.min(1)
	.max(500)
	.regex(/^[^\s\u0000-\u001f]+$/)
const shortId = id.max(255)
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.string().refine((value) => {
	const at = new Date(value)
	return Number.isFinite(at.getTime()) && at.toISOString() === value
}, 'Expected canonical millisecond UTC instant')
const selection = z
	.object({
		bundleId: shortId,
		subjectId: shortId,
		headlineId: shortId,
		openingId: shortId,
		ctaId: shortId,
	})
	.strict()
const revision = deliveryRevisionSchema
	.extend({
		definitionVersion: shortId,
		messagePlanId: shortId,
		contentRevision: shortId,
		presentationReviewRevision: shortId,
	})
	.strict()
export const MAPPING_EVENT_TYPE = 'evergreen.delivery-mapping.recorded'
export const mappingCoreSchema = z
	.object({
		format: z.literal('evergreen.delivery-mapping-record.v1'),
		contactId: shortId,
		journeyId: id,
		idempotencyKey: id,
		claimToken: z.string().uuid(),
		slotId: shortId,
		contentResourceId: shortId,
		presentation: selection,
		revision,
		bindingArtifactSha256: sha,
		bindingEvidenceId: shortId,
		bodySha256: sha,
		sequenceId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		recordedAt: instant,
	})
	.strict()
export type OriginalMappingCore = z.infer<typeof mappingCoreSchema>
export type MappingSource = {
	readonly sourceEventId: string
	readonly providerIdentityId: string
}
export function mappingIdentity(input: {
	journeyId: string
	idempotencyKey: string
	claimToken: string
}) {
	const digest = createHash('sha256')
		.update(
			JSON.stringify([
				id.parse(input.journeyId),
				id.parse(input.idempotencyKey),
				z.string().uuid().parse(input.claimToken),
			]),
		)
		.digest('hex')
	return {
		id: `eodm_${digest}`,
		semanticIdempotencyKey: `evergreen.delivery-mapping:v1:${digest}`,
	}
}
/** Hash actual stored core in an explicit order, independent of MySQL JSON key order.
 * This is agreement evidence, not a signature or a retention guarantee. */
export function mappingDigest(input: unknown) {
	const c = mappingCoreSchema.parse(input),
		p = c.presentation,
		r = c.revision
	return createHash('sha256')
		.update(
			JSON.stringify([
				c.format,
				c.contactId,
				c.journeyId,
				c.idempotencyKey,
				c.claimToken,
				c.slotId,
				c.contentResourceId,
				p.bundleId,
				p.subjectId,
				p.headlineId,
				p.openingId,
				p.ctaId,
				r.definitionVersion,
				r.messagePlanId,
				r.contentRevision,
				r.messagePlanSourceHash,
				r.presentationReviewRevision,
				c.bindingArtifactSha256,
				c.bindingEvidenceId,
				c.bodySha256,
				c.sequenceId,
				c.recordedAt,
			]),
		)
		.digest('hex')
}
const SUMMARY = 'Internal configuration record.'
export function mappingEventRow(
	input: OriginalMappingCore,
	source: MappingSource,
) {
	const core = mappingCoreSchema.parse(input)
	return {
		...mappingIdentity(core),
		contactId: core.contactId,
		providerIdentityId: shortId.parse(source.providerIdentityId),
		provider: 'ai-hero',
		providerEventId: mappingIdentity(core).id,
		providerReference: id.parse(`evergreen-offer-journey:${core.journeyId}`),
		eventType: MAPPING_EVENT_TYPE,
		privacyLevel: 'internal',
		schemaVersion: 1,
		occurredAt: new Date(Math.floor(Date.parse(core.recordedAt) / 1000) * 1000),
		identityEvidence: {
			source: 'ai-hero',
			sourceEventId: shortId.parse(source.sourceEventId),
			providerIdentityId: source.providerIdentityId,
		},
		payloadSummary: {
			summary: SUMMARY,
			keywords: [],
			restrictedPayloadStored: false,
			deliveryMapping: {
				format: 'evergreen.delivery-mapping-record.v1',
				payload: core,
			},
		},
	}
}
const envelope = z.object({
	id: shortId,
	semanticIdempotencyKey: id,
	contactId: shortId,
	providerIdentityId: shortId,
	provider: z.literal('ai-hero'),
	providerEventId: shortId,
	providerReference: id,
	eventType: z.literal(MAPPING_EVENT_TYPE),
	privacyLevel: z.literal('internal'),
	schemaVersion: z.literal(1),
	occurredAt: z.date(),
	createdAt: z.date(),
	identityEvidence: z
		.object({
			source: z.literal('ai-hero'),
			sourceEventId: shortId,
			providerIdentityId: shortId,
		})
		.strict(),
	payloadSummary: z
		.object({
			summary: z.literal(SUMMARY),
			keywords: z.array(z.never()).length(0),
			restrictedPayloadStored: z.literal(false),
			deliveryMapping: z
				.object({
					format: z.literal('evergreen.delivery-mapping-record.v1'),
					payload: mappingCoreSchema,
				})
				.strict(),
		})
		.strict(),
})
export function readMappingEventRow(
	input: unknown,
	source: MappingSource,
): OriginalMappingCore {
	const { createdAt: _createdAt, ...row } = envelope.parse(input)
	const core = row.payloadSummary.deliveryMapping.payload
	const expected = mappingEventRow(core, source)
	if (!isDeepStrictEqual(row, expected))
		throw new Error('Mapping envelope mismatch')
	return core
}
export function sameMappingSelection(
	a: OriginalMappingCore,
	b: OriginalMappingCore,
) {
	return isDeepStrictEqual({ ...a, recordedAt: '' }, { ...b, recordedAt: '' })
}
export function mappingReceipt(core: OriginalMappingCore) {
	const c = mappingCoreSchema.parse(core)
	return {
		format: 'original-delivery-mapping.v1' as const,
		sourceReference: `contact-event:${mappingIdentity(c).id}`,
		sourceReceiptSha256: mappingDigest(c),
		journeyId: c.journeyId,
		idempotencyKey: c.idempotencyKey,
		claimToken: c.claimToken,
		revision: c.revision,
		bindingArtifactSha256: c.bindingArtifactSha256,
		bindingEvidenceId: c.bindingEvidenceId,
		contentResourceId: c.contentResourceId,
		bodySha256: c.bodySha256,
		sequenceId: c.sequenceId,
	}
}
