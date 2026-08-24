import { describe, expect, it, vi } from 'vitest'

import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import type { NextAction, SideEffectIntent } from './types'

function primaryDuplicate() {
	return Object.assign(new Error("Duplicate entry 'abc12' for key 'PRIMARY'"), {
		code: 'ER_DUP_ENTRY',
		errno: 1062,
	})
}

function plannedRecords(attempt: number): {
	nextAction: NextAction
	sideEffectIntents: SideEffectIntent[]
} {
	const nextActionId = `next-action-${attempt}`
	return {
		nextAction: {
			id: nextActionId,
			contactId: 'contact-1',
			contactStateId: 'state-1',
			eventId: 'event-1',
			type: 'enter-value-path',
			status: 'planned',
			gates: [],
			reviewReasons: [],
			rationale: [],
			createdAt: '2026-08-09T00:00:00.000Z',
		},
		sideEffectIntents: [
			{
				id: `intent-${attempt}`,
				nextActionId,
				contactId: 'contact-1',
				provider: 'dry-run',
				type: 'preview-shadow-field-sync',
				status: 'dry-run',
				idempotencyKey: 'gate-b:event-1:enter-value-path',
				gates: [],
				reviewReasons: [],
				metadata: {},
				createdAt: '2026-08-09T00:00:00.000Z',
			},
		],
	}
}

describe('DrizzleCaptureMarketingRepository collision handling', () => {
	it('retries linked records as one transaction with consistent references', async () => {
		let transactionAttempt = 0
		const committedRows: unknown[][] = []
		const database = {
			transaction: vi.fn(async (write: (tx: unknown) => Promise<void>) => {
				transactionAttempt++
				const rows: unknown[] = []
				let insertNumber = 0
				const tx = {
					insert: vi.fn(() => ({
						values: async (value: unknown) => {
							insertNumber++
							rows.push(value)
							if (
								(transactionAttempt === 1 && insertNumber === 1) ||
								(transactionAttempt === 2 && insertNumber === 2)
							) {
								throw primaryDuplicate()
							}
						},
					})),
				}
				await write(tx)
				committedRows.push(rows)
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)
		let plannedAttempt = 0

		const result = await repository.createNextActionWithSideEffectIntents(() =>
			plannedRecords(++plannedAttempt),
		)

		expect(database.transaction).toHaveBeenCalledTimes(3)
		expect(result.nextAction.id).toBe('next-action-3')
		expect(result.sideEffectIntents[0]?.nextActionId).toBe(result.nextAction.id)
		expect(committedRows).toHaveLength(1)
		expect(committedRows[0]).toEqual([
			expect.objectContaining({ id: 'next-action-3' }),
			expect.objectContaining({
				id: 'intent-3',
				nextActionId: 'next-action-3',
			}),
		])
	})

	it('keeps old five-character stored IDs readable', async () => {
		const database = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [
							{
								id: 'a1b2c',
								nextActionId: 'c3d4e',
								contactId: 'contact-1',
								provider: 'kit',
								type: 'send-value-path-email',
								status: 'pending',
								completedAt: null,
								idempotencyKey: 'contact:1:path:email:0',
								gates: [],
								reviewReasons: [],
								metadata: {},
								createdAt: new Date('2026-08-01T00:00:00.000Z'),
							},
						],
					}),
				}),
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)

		await expect(
			repository.findSideEffectIntentByIdempotencyKey('contact:1:path:email:0'),
		).resolves.toMatchObject({
			id: 'a1b2c',
			nextActionId: 'c3d4e',
		})
	})
})
