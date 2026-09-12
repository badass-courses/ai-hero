import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql-proxy'
import { expect, it, vi } from 'vitest'
import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'

it.each(['text', 'object'] as const)(
	'renders the repository intent SELECT and decodes the attached %s metadata projection',
	async (shape) => {
		// mysql-proxy has no built-in connection or transport: this mandatory callback
		// is the only executor. It receives generated SQL and returns synthetic rows.
		const calls: Array<{ sql: string; params: unknown[] }> = []
		const render = vi.spyOn(MySqlDialect.prototype, 'sqlToQuery')
		const projection = {
			values: {
				emailResourceId: 'step-1',
				kitSequenceId: null,
				completedAt: null,
				retryable: true,
				nextRetryAt: null,
			},
			present: {
				emailResourceId: 1,
				kitSequenceId: 1,
				completedAt: 0,
				retryable: 1,
				nextRetryAt: 0,
			},
		}
		const envelope = shape === 'text' ? JSON.stringify(projection) : projection
		const database = drizzle(
			async (sql, params) => {
				if (!/^select\s/i.test(sql))
					throw new Error(
						'Synthetic SQL callback refuses non-SELECT statements',
					)
				calls.push({ sql, params })
				return {
					rows:
						calls.length === 1
							? [
									[
										'intent-1',
										'contact-1',
										'sending',
										'2026-09-01 00:00:00',
										null,
										envelope,
										[],
									],
								]
							: [],
				}
			},
			{ logger: false },
		)
		try {
			const repository = new DrizzleCaptureMarketingRepository(database)
			const pages = []
			for await (const page of repository.findGateDStatusPages(['contact-1']))
				pages.push(page)
			expect(render).toHaveBeenCalled()
			expect(calls).toHaveLength(2)
			expect(calls[0]).toEqual({
				sql: "select `id`, `contactId`, `status`, `createdAt`, `completedAt`, json_object('values', json_object(?, json_extract(`AI_SideEffectIntent`.`metadata`, ?), ?, json_extract(`AI_SideEffectIntent`.`metadata`, ?), ?, json_extract(`AI_SideEffectIntent`.`metadata`, ?), ?, json_extract(`AI_SideEffectIntent`.`metadata`, ?), ?, json_extract(`AI_SideEffectIntent`.`metadata`, ?)), 'present', json_object(?, json_contains_path(`AI_SideEffectIntent`.`metadata`, 'one', ?), ?, json_contains_path(`AI_SideEffectIntent`.`metadata`, 'one', ?), ?, json_contains_path(`AI_SideEffectIntent`.`metadata`, 'one', ?), ?, json_contains_path(`AI_SideEffectIntent`.`metadata`, 'one', ?), ?, json_contains_path(`AI_SideEffectIntent`.`metadata`, 'one', ?))), `reviewReasons` from `AI_SideEffectIntent` where (`AI_SideEffectIntent`.`contactId` in (?) and `AI_SideEffectIntent`.`type` = ?) order by `AI_SideEffectIntent`.`id` asc limit ?",
				params: [
					'emailResourceId',
					'$.emailResourceId',
					'kitSequenceId',
					'$.kitSequenceId',
					'completedAt',
					'$.completedAt',
					'retryable',
					'$.retryable',
					'nextRetryAt',
					'$.nextRetryAt',
					'emailResourceId',
					'$.emailResourceId',
					'kitSequenceId',
					'$.kitSequenceId',
					'completedAt',
					'$.completedAt',
					'retryable',
					'$.retryable',
					'nextRetryAt',
					'$.nextRetryAt',
					'contact-1',
					'send-value-path-email',
					5000,
				],
			})
			// This result went through Drizzle's selected-field row mapper. The test
			// never calls decodeGateDStatusMetadata itself, so missing mapWith wiring fails.
			expect(pages[0]?.intents).toEqual([
				{
					id: 'intent-1',
					contactId: 'contact-1',
					status: 'sending',
					createdAt: new Date('2026-09-01T00:00:00.000Z'),
					completedAt: null,
					metadata: {
						emailResourceId: 'step-1',
						kitSequenceId: null,
						retryable: true,
					},
					reviewReasons: [],
				},
			])
		} finally {
			render.mockRestore()
		}
	},
)
