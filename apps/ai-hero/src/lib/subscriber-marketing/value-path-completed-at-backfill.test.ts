import { describe, expect, it } from 'vitest'

import type { SideEffectIntent } from './types'
import { backfillMissingValuePathCompletedAt } from './value-path-completed-at-backfill'
import { isValuePathIntentCompleted } from './value-path-completion'

function completedIntent(
	overrides: Partial<SideEffectIntent> = {},
): SideEffectIntent {
	return {
		id: 'completed-without-canonical-column',
		nextActionId: 'next-action',
		contactId: 'contact-1',
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'completed',
		idempotencyKey:
			'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0',
		gates: [],
		reviewReasons: [],
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
			completedAt: '2026-07-15T12:05:00.000Z',
		},
		createdAt: '2026-07-15T12:00:00.000Z',
		...overrides,
	}
}

describe('value path canonical completedAt backfill', () => {
	it('copies the legacy stamp into the canonical column and is idempotent', async () => {
		const intent = completedIntent()
		const intents = new Map([[intent.id, intent]])
		const repository = {
			findCompletedValuePathEmailSideEffectIntentsForRepair: () =>
				Array.from(intents.values()),
			updateSideEffectIntent: (
				id: string,
				patch: Pick<
					SideEffectIntent,
					'status' | 'gates' | 'reviewReasons' | 'metadata'
				> & Pick<SideEffectIntent, 'completedAt'>,
			) => {
				const current = intents.get(id)
				if (!current) throw new Error(`Missing intent ${id}`)
				const updated = { ...current, ...patch }
				intents.set(id, updated)
				return updated
			},
		}

		const dryRun = await backfillMissingValuePathCompletedAt({
			repository,
			allowWrite: false,
			now: '2026-07-17T12:00:00.000Z',
		})
		expect(dryRun.counts).toMatchObject({
			missingCanonicalCompletedAt: 1,
			repairableFromLegacyMetadata: 1,
			wouldUpdate: 1,
			updated: 0,
		})
		expect(intents.get(intent.id)?.completedAt).toBeUndefined()

		const write = await backfillMissingValuePathCompletedAt({
			repository,
			allowWrite: true,
			now: '2026-07-17T12:01:00.000Z',
		})
		expect(write.counts.updated).toBe(1)
		const repaired = intents.get(intent.id)!
		expect(repaired.completedAt).toBe('2026-07-15T12:05:00.000Z')
		expect(repaired.metadata).toMatchObject({
			completedAt: '2026-07-15T12:05:00.000Z',
			completedAtBackfillSource: 'legacy-metadata',
		})
		expect(isValuePathIntentCompleted(repaired)).toBe(true)

		const rerun = await backfillMissingValuePathCompletedAt({
			repository,
			allowWrite: true,
			now: '2026-07-17T12:02:00.000Z',
		})
		expect(rerun.counts).toMatchObject({
			missingCanonicalCompletedAt: 0,
			wouldUpdate: 0,
			updated: 0,
		})
	})

	it('uses provider evidence only when the legacy stamp is absent', async () => {
		const intent = completedIntent({
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				providerResult: { completedAt: '2026-07-15T12:06:00.000Z' },
			},
		})
		let updated: SideEffectIntent | undefined
		const result = await backfillMissingValuePathCompletedAt({
			repository: {
				findCompletedValuePathEmailSideEffectIntentsForRepair: () => [intent],
				updateSideEffectIntent: (_id, patch) => (updated = { ...intent, ...patch }),
			},
			allowWrite: true,
		})
		expect(result.counts.repairableFromProviderEvidence).toBe(1)
		expect(updated?.completedAt).toBe('2026-07-15T12:06:00.000Z')
	})
})
