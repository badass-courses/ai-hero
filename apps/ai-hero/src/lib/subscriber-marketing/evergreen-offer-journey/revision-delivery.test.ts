import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeAttempt } from './attempt-evidence'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type { SendMessageIntent } from './domain'
import {
	parseContactId,
	parseJourneyId,
	parseIntentKey,
	parseIsoInstant,
} from './primitives'
import { syntheticRevisionScope } from './revision-delivery.fixtures'
import { captureRevisionScope, originalMappingSchema } from './revision-scope'

function value<T>(parsed: { ok: true; value: T } | { ok: false }): T {
	if (!parsed.ok) throw new Error('invalid fixture')
	return parsed.value
}
const message = EVERGREEN_OFFER_JOURNEY_V1.bridge[2]
const intent: SendMessageIntent = {
	type: 'SendMessage',
	...message,
	idempotencyKey: value(
		parseIntentKey(`evergreen-offer:test:message:${message.contentResourceId}`),
	),
	journeyId: value(parseJourneyId('evergreen-offer:test')),
	contactId: value(parseContactId('synthetic')),
	notBefore: value(parseIsoInstant('2026-09-08T17:00:00.000Z')),
	notAfter: value(parseIsoInstant('2026-09-09T17:00:00.000Z')),
	couponId: null,
}
const attempt = decodeAttempt({
	format: 'evergreen-offer-journey.attempt.v1',
	journeyId: intent.journeyId,
	idempotencyKey: intent.idempotencyKey,
	claimToken: 'f889c3b4-2f4a-4ca5-aed3-fcba33c92aa8',
	claimedAt: new Date(intent.notBefore),
	leaseExpiresAt: new Date('2026-09-08T17:01:00.000Z'),
	status: 'Claimed',
	outcome: null,
})

describe('original-mapping receipt boundary', () => {
	it('requires exact separately supplied synthetic receipt, not current scope alone', async () => {
		const scope = syntheticRevisionScope()
		expect(
			await Effect.runPromise(
				captureRevisionScope(scope).original(attempt, intent),
			),
		).toBe(true)
		expect(
			await Effect.runPromise(
				captureRevisionScope({ ...scope, originalMapping: null }).original(
					attempt,
					intent,
				),
			),
		).toBe(false)
	})
	it.each([
		'journeyId',
		'idempotencyKey',
		'claimToken',
		'bindingArtifactSha256',
		'contentResourceId',
		'bodySha256',
		'sequenceId',
		'sourceReceiptSha256',
		'sourceReference',
	] as const)('holds wrong/missing receipt %s', async (field) => {
		const scope = syntheticRevisionScope()
		const receipt = originalMappingSchema.parse(
			await Effect.runPromise(scope.originalMapping!.read(attempt)),
		)
		const corrupted = {
			...receipt,
			[field]:
				field === 'sequenceId'
					? 9999
					: field === 'claimToken'
						? 'ad654ed4-4469-4be1-8c71-67ec65efc10f'
						: field.endsWith('Sha256')
							? field === 'sourceReceiptSha256'
								? ''
								: 'f'.repeat(64)
							: field === 'sourceReference'
								? ''
								: 'wrong',
		}
		expect(
			await Effect.runPromise(
				captureRevisionScope({
					...scope,
					originalMapping: { read: () => Effect.succeed(corrupted) },
				}).original(attempt, intent),
			),
		).toBe(false)
	})
	it.each([
		'definitionVersion',
		'messagePlanId',
		'contentRevision',
		'messagePlanSourceHash',
		'presentationReviewRevision',
	] as const)('holds receipt tuple mismatch %s', async (field) => {
		const scope = syntheticRevisionScope()
		const receipt = originalMappingSchema.parse(
			await Effect.runPromise(scope.originalMapping!.read(attempt)),
		)
		const corrupted = {
			...receipt,
			revision: {
				...receipt.revision,
				[field]: field === 'messagePlanSourceHash' ? 'f'.repeat(64) : 'wrong',
			},
		}
		expect(
			await Effect.runPromise(
				captureRevisionScope({
					...scope,
					originalMapping: { read: () => Effect.succeed(corrupted) },
				}).original(attempt, intent),
			),
		).toBe(false)
	})
	it('holds an unavailable receipt reader', async () => {
		const scope = syntheticRevisionScope()
		expect(
			await Effect.runPromise(
				captureRevisionScope({
					...scope,
					originalMapping: { read: () => Effect.fail('unavailable') },
				}).original(attempt, intent),
			),
		).toBe(false)
	})
	it('clones and recursively freezes manifest, rejecting ambiguous selections', () => {
		const source = syntheticRevisionScope()
		const captured = captureRevisionScope(source)
		source.manifest.messages[2]!.sequenceId = 9999
		expect(captured.manifest?.messages[2]?.sequenceId).toBe(1002)
		expect(Object.isFrozen(captured.manifest?.messages[2]?.presentation)).toBe(
			true,
		)
		source.manifest.messages[2]!.sequenceId =
			source.manifest.messages[1]!.sequenceId
		expect(captureRevisionScope(source).manifest).toBeNull()
	})
})
