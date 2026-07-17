import { describe, expect, it } from 'vitest'

import type { SideEffectIntent } from './types'
import { backfillMissingValuePathCompletedAt } from './value-path-completed-at-backfill'
import { isLocalDayDripDue } from './value-path-drip-progression'
import { selectCompletedValuePathIntentFrontier } from './value-path-intent-scan'

describe('value path completedAt backfill', () => {
	it('makes a status-completed intent progressible and is idempotent', async () => {
		const intent: SideEffectIntent = {
			id: 'completed-without-stamp',
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
				providerResult: { completedAt: '2026-07-15T12:05:00.000Z' },
			},
			createdAt: '2026-07-15T12:00:00.000Z',
		}
		const intents = new Map([[intent.id, intent]])
		const repository = {
			findCompletedValuePathEmailSideEffectIntentsForRepair: () =>
				Array.from(intents.values()),
			updateSideEffectIntent: (
				id: string,
				patch: Pick<
					SideEffectIntent,
					'status' | 'gates' | 'reviewReasons' | 'metadata'
				>,
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
			missingOrInvalidCompletedAt: 1,
			wouldUpdate: 1,
			updated: 0,
		})
		expect(intents.get(intent.id)?.metadata.completedAt).toBeUndefined()

		const write = await backfillMissingValuePathCompletedAt({
			repository,
			allowWrite: true,
			now: '2026-07-17T12:01:00.000Z',
		})
		expect(write.counts.updated).toBe(1)
		const repaired = intents.get(intent.id)!
		expect(repaired.metadata).toMatchObject({
			completedAt: '2026-07-15T12:05:00.000Z',
			completedAtBackfillSource: 'provider-completion-evidence',
		})
		expect(
			selectCompletedValuePathIntentFrontier({
				intents: [repaired],
				limit: 1,
			}),
		).toHaveLength(1)
		expect(
			isLocalDayDripDue({
				completedAt: String(repaired.metadata.completedAt),
				now: '2026-07-17T12:00:00.000Z',
			}),
		).toMatchObject({ due: true })

		const rerun = await backfillMissingValuePathCompletedAt({
			repository,
			allowWrite: true,
			now: '2026-07-17T12:02:00.000Z',
		})
		expect(rerun.counts).toMatchObject({
			missingOrInvalidCompletedAt: 0,
			wouldUpdate: 0,
			updated: 0,
		})
	})
})
