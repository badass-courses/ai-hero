import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({ transaction: vi.fn() }))

vi.mock('@/db', () => ({ db: dbMock }))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn() } }))

import { sha256, stableJson } from './control-plane'
import {
	claimCourseSyncReviewNotification,
	completeCourseSyncReviewNotification,
	courseSyncRevisionHeadWhere,
	saveCourseSyncPollState,
} from './detection-persistence'
import type { CourseSyncPollState } from './detection-poller'

function pollState(
	status: CourseSyncPollState['status'],
	updatedAt: string,
): CourseSyncPollState {
	return {
		bindingId: 'csb_ai_coding_crash_course',
		courseVersionId: 'version-1',
		providerRevision: 'dropbox-rev-1',
		status,
		consecutiveFailures: status === 'held' ? 1 : 0,
		controlPlaneRunId: 'run-1',
		failureClass: status === 'held' ? 'APPLIED_RUN_ROLLED_BACK' : null,
		applyPolicyOverride: null,
		updatedAt: new Date(updatedAt),
	}
}

describe('course-sync revision head persistence', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('excludes compensating rollback runs from successful head selection', () => {
		const dialect = new MySqlDialect()
		const condition = courseSyncRevisionHeadWhere(
			'csb_ai_coding_crash_course',
		)
		if (!condition) throw new Error('revision-head condition missing')
		const query = dialect.sqlToQuery(condition.getSQL())

		expect(query.sql).toContain('`AI_CourseSyncRun`.`rollbackOfRunId` is null')
	})

	it('claims each review plan notification once with a durable receipt', async () => {
		const storedValues: Array<Record<string, unknown>> = []
		const receipt = { value: null as Record<string, unknown> | null }
		const makeTransaction = () => {
			let selectIndex = 0
			return {
				select: vi.fn(() => {
					const rows =
						selectIndex++ === 0
							? [{ bindingId: 'csb_ai_coding_crash_course' }]
							: receipt.value
								? [receipt.value]
								: []
					const query = {
						from: vi.fn(),
						where: vi.fn(),
						for: vi.fn(async () => rows),
					}
					query.from.mockReturnValue(query)
					query.where.mockReturnValue(query)
					return query
				}),
				insert: vi.fn(() => ({
					values: vi.fn(async (value: Record<string, unknown>) => {
						storedValues.push(value)
						receipt.value = { ...value }
					}),
				})),
				update: vi.fn(() => {
					const query = {
						set: vi.fn(),
						where: vi.fn(async () => undefined),
					}
					query.set.mockImplementation((value: Record<string, unknown>) => {
						receipt.value = { ...receipt.value, ...value }
						return query
					})
					return query
				}),
			}
		}
		dbMock.transaction.mockImplementation(
			async (
				run: (
					transaction: ReturnType<typeof makeTransaction>,
				) => Promise<boolean>,
			) => run(makeTransaction()),
		)
		const input = {
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-1',
			providerRevision: 'dropbox-rev-1',
			runId: 'poll-1',
			controlPlaneRunId: 'run-1',
			planSha256: 'a'.repeat(64),
			occurredAt: new Date('2026-08-17T16:00:00.000Z'),
		}

		await expect(claimCourseSyncReviewNotification(input)).resolves.toBe(true)
		await expect(claimCourseSyncReviewNotification(input)).resolves.toBe(false)
		await completeCourseSyncReviewNotification({
			...input,
			occurredAt: new Date('2026-08-17T16:00:01.000Z'),
		})
		await expect(claimCourseSyncReviewNotification(input)).resolves.toBe(false)
		expect(receipt.value).toMatchObject({ outcome: 'succeeded' })
		expect(storedValues).toHaveLength(1)
		expect(storedValues[0]).toMatchObject({
			stage: 'notify',
			outcome: 'started',
			metadata: {
				kind: 'review',
				planSha256: 'a'.repeat(64),
			},
		})
		// Review receipts already exist in production. A caller that omits the
		// kind must land on the same row it landed on before the applied kind
		// existed, or every open review re-notifies.
		expect(storedValues[0]?.id).toBe(
			`cspl_review_notice_${sha256(
				stableJson({
					kind: 'review',
					bindingId: input.bindingId,
					courseVersionId: input.courseVersionId,
					planSha256: input.planSha256,
				}),
			)}`,
		)
	})

	it('preserves a locked operator override across automatic failure saves', async () => {
		const current = {
			...pollState('failed', '2026-08-21T18:01:00.000Z'),
			applyPolicyOverride: 'operator' as const,
		}
		const lockedRows = [
			[{ bindingId: 'csb_ai_coding_crash_course' }],
			[current],
		]
		const values = vi.fn(() => ({
			onDuplicateKeyUpdate: vi.fn(async () => undefined),
		}))
		const trx = {
			select: vi.fn(() => {
				const rows = lockedRows.shift() ?? []
				const query = {
					from: vi.fn(),
					where: vi.fn(),
					for: vi.fn(async () => rows),
				}
				query.from.mockReturnValue(query)
				query.where.mockReturnValue(query)
				return query
			}),
			insert: vi.fn(() => ({ values })),
		}
		dbMock.transaction.mockImplementationOnce(
			async (run: (transaction: typeof trx) => Promise<void>) => run(trx),
		)

		await saveCourseSyncPollState({
			...current,
			applyPolicyOverride: null,
			updatedAt: new Date('2026-08-21T18:02:00.000Z'),
		})

		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({ applyPolicyOverride: 'operator' }),
		)
	})

	it('keeps a rollback hold when a stale succeeded save acquires the lock later', async () => {
		const insert = vi.fn()
		const lockedRows = [
			[{ bindingId: 'csb_ai_coding_crash_course' }],
			[pollState('held', '2026-08-16T19:00:00.000Z')],
		]
		const trx = {
			select: vi.fn(() => {
				const rows = lockedRows.shift() ?? []
				const query = {
					from: vi.fn(),
					where: vi.fn(),
					for: vi.fn(async () => rows),
				}
				query.from.mockReturnValue(query)
				query.where.mockReturnValue(query)
				return query
			}),
			insert,
		}
		dbMock.transaction.mockImplementationOnce(
			async (run: (transaction: typeof trx) => Promise<void>) => run(trx),
		)

		await saveCourseSyncPollState(
			pollState('succeeded', '2026-08-16T18:59:59.000Z'),
		)

		expect(trx.select).toHaveBeenCalledTimes(2)
		expect(insert).not.toHaveBeenCalled()
	})
})
