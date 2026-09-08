import { describe, it, expect, vi, afterEach } from 'vitest'
import * as classifier from '../signal-classifier'
import * as reducer from '../state-reducer'
import * as planner from '../intent-planner'
import { codingWorkflowFixture } from '../__fixtures__/quick-question-fixtures'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from '../dry-run'
import {
	InMemoryOperatorLookupRepository,
	previewSubscriberMarketingReplay,
} from '../operator-lookup'
import type { ContactEventRecord } from '../types'
import { preparationFixture } from './message-preparation.fixtures'
import { preparationEventRow } from './message-preparation-store'

describe('strict preparation consumer isolation', () => {
	afterEach(() => { vi.restoreAllMocks() })
	it.each(
		(
			[
				'snapshot',
				'namespace',
				'fields-requested',
				'enrollment-requested',
			] as const
		).flatMap((stage) => [true, false].map((stored) => ({ stage, stored }))),
	)('keeps $stage nonbehavioral; stored=$stored', async ({ stage, stored }) => {
		const repository = new InMemorySubscriberMarketingRepository()
		const initial = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-04T13:00:00.000Z',
		})
		const snapshot = {
			...preparationFixture().snapshot,
			contactId: initial.contact.id,
			providerIdentityId: initial.providerIdentity.id,
		}
		const row = preparationEventRow({
			version: 1,
			stage,
			observedAt: snapshot.preparedAt,
			snapshot,
		})
		const event = {
			...row,
			occurredAt: row.occurredAt.toISOString(),
			createdAt: snapshot.preparedAt,
		} as unknown as ContactEventRecord
		repository.contactEvents.set(event.id, event)
		if (!stored) repository.states.clear()
		const classify = vi.spyOn(classifier, 'classifyContactEvent'),
			reduce = vi.spyOn(reducer, 'reduceContactState'),
			plan = vi.spyOn(planner, 'planDryRunIntents')
		const before = JSON.stringify([
			Array.from(repository.states),
			Array.from(repository.transitions),
			Array.from(repository.nextActions),
			Array.from(repository.sideEffectIntents),
		])
		const args = {
			repository: new InMemoryOperatorLookupRepository(repository),
			contactId: initial.contact.id,
			now: '2026-09-08T02:00:01.000Z',
		}
		const result = await previewSubscriberMarketingReplay(args)
		expect(result.mode).toBe('non-behavioral-replay-preview')
		expect(result.preview.classification).toBeNull()
		expect(result.preview.nextAction).toBeNull()
		expect(result.preview.sideEffectIntents).toEqual([])
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
		repository.contactEvents.set(event.id, {
			...event,
			payloadSummary: { summary: 'malformed', keywords: [], restrictedPayloadStored: false },
		})
		await expect(previewSubscriberMarketingReplay(args)).rejects.toThrow(
			'Malformed preparation evidence',
		)
		expect(classify).not.toHaveBeenCalled()
		expect(plan).not.toHaveBeenCalled()
	})
})
