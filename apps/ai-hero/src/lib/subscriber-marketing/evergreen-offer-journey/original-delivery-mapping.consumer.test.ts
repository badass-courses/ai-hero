import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'
import * as classifier from '../signal-classifier'
import * as reducer from '../state-reducer'
import * as planner from '../intent-planner'
import {
	codingWorkflowFixture,
	supportFixture,
} from '../__fixtures__/quick-question-fixtures'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from '../dry-run'
import {
	InMemoryOperatorLookupRepository,
	previewSubscriberMarketingReplay,
} from '../operator-lookup'
import { classifyContactEvent } from '../signal-classifier'
import type { ContactEventRecord } from '../types'
import { mappingCoreSchema, mappingEventRow } from './original-delivery-mapping'
import { syntheticRevisionScope } from './revision-delivery.fixtures'

describe('internal mapping consumer isolation', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})
	it.each(
		[codingWorkflowFixture, supportFixture].flatMap((fixture) =>
			[true, false].flatMap((stored) =>
				[true, false].map((explicit) => ({ fixture, stored, explicit })),
			),
		),
	)(
		'non-behavioral preview stored=$stored explicit=$explicit',
		async ({ fixture, stored, explicit }) => {
			const repository = new InMemorySubscriberMarketingRepository()
			const initial = await dryRunSubscriberMarketingFixture({
				repository,
				fixture,
				now: '2026-05-04T13:00:00.000Z',
			})
			const manifest = syntheticRevisionScope().manifest,
				selected = manifest.messages[0]!
			const core = mappingCoreSchema.parse({
				format: 'evergreen.delivery-mapping-record.v1',
				contactId: initial.contact.id,
				journeyId: 'test-journey',
				idempotencyKey: 'test-intent',
				claimToken: randomUUID(),
				slotId: selected.slotId,
				contentResourceId: selected.contentResourceId,
				presentation: selected.presentation,
				revision: manifest.revision,
				bindingArtifactSha256: manifest.bindingArtifactSha256,
				bindingEvidenceId: manifest.bindingEvidenceId,
				bodySha256: selected.bodySha256,
				sequenceId: selected.sequenceId,
				recordedAt: '2026-09-08T02:00:00.123Z',
			})
			const row = mappingEventRow(core, {
				sourceEventId: initial.contactEvent.id,
				providerIdentityId: initial.providerIdentity.id,
			})
			// Same persistence-to-operator conversion as drizzle-operator-lookup-repository:
			// SQL dates become strings, identity JSON is carried intact (not reclassified).
			const event = {
				...row,
				occurredAt: row.occurredAt.toISOString(),
				createdAt: core.recordedAt,
			} as unknown as ContactEventRecord
			repository.contactEvents.set(event.id, event)
			const classification = classifyContactEvent(event)
			expect(classification.whySignals).toEqual(['other-unclear'])
			expect(classification.whoSignals).toEqual(['unclear'])
			expect(
				classification.reviewSignals.filter(
					(s) => s !== 'low-confidence' && s !== 'ambiguous',
				),
			).toEqual([])
			if (!stored) repository.states.clear()
			const classify = vi.spyOn(classifier, 'classifyContactEvent'),
				reduce = vi.spyOn(reducer, 'reduceContactState'),
				plan = vi.spyOn(planner, 'planDryRunIntents')
			const prior =
				repository.states.get(initial.contact.id) ??
				Array.from(repository.states.values())[0]
			const before = JSON.stringify([
				Array.from(repository.states),
				Array.from(repository.transitions),
				Array.from(repository.nextActions),
				Array.from(repository.sideEffectIntents),
			])
			const preview = await previewSubscriberMarketingReplay({
				repository: new InMemoryOperatorLookupRepository(repository),
				contactId: initial.contact.id,
				...(explicit ? { eventId: event.id } : {}),
				now: '2026-09-08T02:00:01.000Z',
			})
			expect(preview.preview.contactEvent.id).toBe(event.id) // no eventId: actual type-agnostic latest selector
			expect(preview.mode).toBe('non-behavioral-replay-preview')
			if (preview.mode !== 'non-behavioral-replay-preview')
				throw new Error('Expected non-behavioral preview')
			expect(preview.preview.state).toBe(
				stored ? 'stored-state' : 'no-stored-state',
			)
			expect(preview.preview.contactState).toEqual(stored ? prior : null)
			expect(preview.preview.classification).toBeNull()
			expect(preview.preview.nextAction).toBeNull()
			expect(preview.preview.sideEffectIntents).toEqual([])
			expect(Object.values(preview.diff)).toEqual([false, false, false, false])
			expect(classify).not.toHaveBeenCalled()
			expect(reduce).not.toHaveBeenCalled()
			expect(plan).not.toHaveBeenCalled()
			expect(
				JSON.stringify([
					Array.from(repository.states),
					Array.from(repository.transitions),
					Array.from(repository.nextActions),
					Array.from(repository.sideEffectIntents),
				]),
			).toBe(before)
		},
	)
})
