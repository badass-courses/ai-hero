import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type { EvergreenOfferJourneyDefinition } from './domain'
import { revisionOf, type DeliveryRevisionScope } from './revision-scope'

/** Fabricated mapping receipts ONLY for isolated tests. This is deliberately not
 * a production original-mapping reader and proves no historical deployment. */
export function syntheticRevisionScope(
	definition: EvergreenOfferJourneyDefinition = EVERGREEN_OFFER_JOURNEY_V1,
): DeliveryRevisionScope {
	const digest = (value: string) =>
		createHash('sha256').update(value).digest('hex')
	const manifest = {
		revision: revisionOf(definition),
		bindingArtifactSha256: digest(definition.definitionVersion),
		bindingEvidenceId: `synthetic:${definition.definitionVersion}`,
		messages: [...definition.bridge, ...definition.pitch].map(
			(message, index) => ({
				...message,
				bodySha256: digest(
					message.slotId === 'B3'
						? definition.definitionVersion === 'evergreen-offer-v2'
							? 'SYNTHETIC Friday B3'
							: 'SYNTHETIC Thursday B3'
						: `SYNTHETIC ${definition.definitionVersion}:${message.slotId}`,
				),
				sequenceId:
					(definition.definitionVersion === 'evergreen-offer-v2'
						? 2000
						: 1000) + index,
			}),
		),
	}
	return {
		manifest,
		originalMapping: {
			read: (attempt) =>
				Effect.sync(() => {
					const selected = manifest.messages.find((m) =>
						attempt.idempotencyKey.endsWith(`:message:${m.contentResourceId}`),
					)
					if (!selected) return null
					return {
						format: 'original-delivery-mapping.v1',
						sourceReceiptSha256: digest(`synthetic:${attempt.claimToken}`),
						sourceReference: 'synthetic-test-only-not-provider-proof',
						journeyId: attempt.journeyId,
						idempotencyKey: attempt.idempotencyKey,
						claimToken: attempt.claimToken,
						revision: manifest.revision,
						bindingArtifactSha256: manifest.bindingArtifactSha256,
						contentResourceId: selected.contentResourceId,
						bodySha256: selected.bodySha256,
						sequenceId: selected.sequenceId,
					}
				}),
		},
	}
}
