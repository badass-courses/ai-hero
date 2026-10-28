import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
	key: vi.fn(() => 'test-key'),
}))
vi.mock('next/server', () => ({ after: mocks.after }))
vi.mock('./drovr-shadow-emitter', () => ({ drovrApiKeyForTenant: mocks.key }))
import {
	deliverGoalInterestFact,
	recordInterestFacts,
	scheduleGoalInterestFact,
} from './survey-interest-facts-live'
import { goalInterestFact, GOAL_QUESTION_ID } from './survey-interest-facts'

const config = { baseUrl: 'https://drovr.example.test/', apiKey: 'test-key' }
const row = {
	id: 'response-1',
	questionId: GOAL_QUESTION_ID,
	answer: 'team_workflows',
	createdAt: new Date('2026-10-28T17:20:00Z'),
	email: ' HUMAN@example.test ',
}
const resolutionResponse = () =>
	Response.json({
		results: [{ index: 0, status: 'resolved', contactId: 'drovr-contact' }],
	})
const acceptedResponse = () =>
	Response.json({
		inserted: 1,
		duplicates: 0,
		conflicts: [],
		nextMoves: [],
		extra: true,
	})

beforeEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.stubEnv('AIH_DROVR_SURVEY_INTEREST_FACTS_ENABLED', 'true')
})

describe('live goal interest facts', () => {
	it.each([undefined, 'false', '1'])('does not schedule when the rollout flag is %s', (flag) => {
		if (flag === undefined) delete process.env.AIH_DROVR_SURVEY_INTEREST_FACTS_ENABLED
		else vi.stubEnv('AIH_DROVR_SURVEY_INTEREST_FACTS_ENABLED', flag)
		scheduleGoalInterestFact(row, { info: vi.fn() })
		expect(mocks.after).not.toHaveBeenCalled()
	})
	it('resolves through the existing client and posts the exact flat tenant/campaign payload', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(resolutionResponse())
			.mockResolvedValueOnce(acceptedResponse())
		await deliverGoalInterestFact({
			row,
			logger: { info: vi.fn() },
			config,
			fetcher,
		})
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			'https://drovr.example.test/resolve_contacts',
		)
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
			items: [{ email: 'human@example.test' }],
		})
		expect(fetcher.mock.calls[1]?.[0]).toBe(
			'https://drovr.example.test/record_interest_facts',
		)
		const request = fetcher.mock.calls[1]?.[1]
		expect(request?.headers).toMatchObject({
			authorization: 'Bearer test-key',
		})
		expect(JSON.parse(String(request?.body))).toEqual({
			tenantId: 'org-aihero',
			campaignId: 'contact-segments',
			facts: [goalInterestFact({ ...row, contactId: 'drovr-contact' })],
		})
		expect(String(request?.body)).not.toMatch(/email|HUMAN|https:/)
	})
	it.each(['resolve', 'post', 'bad-ack', 'conflict'])(
		'swallows %s failure even when logging fails',
		async (failure) => {
			const fetcher = vi.fn<
				Parameters<typeof fetch>,
				ReturnType<typeof fetch>
			>()
			if (failure === 'resolve')
				fetcher.mockRejectedValueOnce(new Error('private error'))
			else {
				fetcher.mockResolvedValueOnce(resolutionResponse())
				fetcher.mockResolvedValueOnce(
					failure === 'post'
						? new Response('private error', { status: 503 })
						: failure === 'bad-ack'
							? Response.json({})
							: Response.json({
									inserted: 0,
									duplicates: 0,
									conflicts: ['response-1'],
								}),
				)
			}
			const logger = { info: vi.fn().mockRejectedValue(new Error('log-down')) }
			await expect(
				deliverGoalInterestFact({ row, logger, config, fetcher }),
			).resolves.toBeUndefined()
			expect(logger.info).toHaveBeenCalledWith('survey.interest_fact.failed', {
				rowId: 'response-1',
				reason: 'delivery-failed',
			})
		},
	)
	it('does not post for a missing/conflicting contact or missing email', async () => {
		for (const status of ['missing', 'conflict']) {
			const fetcher = vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockResolvedValue(Response.json({ results: [{ index: 0, status }] }))
			await deliverGoalInterestFact({
				row,
				logger: { info: vi.fn() },
				config,
				fetcher,
			})
			expect(fetcher).toHaveBeenCalledTimes(1)
		}
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
		await deliverGoalInterestFact({
			row: { ...row, email: null },
			logger: { info: vi.fn() },
			config,
			fetcher,
		})
		expect(fetcher).not.toHaveBeenCalled()
	})
	it('defers all network work until after the response', async () => {
		vi.stubEnv('DROVR_API_BASE_URL', config.baseUrl)
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(resolutionResponse())
			.mockResolvedValueOnce(acceptedResponse())
		vi.stubGlobal('fetch', fetcher)
		scheduleGoalInterestFact(row, { info: vi.fn() })
		expect(mocks.after).toHaveBeenCalledOnce()
		expect(fetcher).not.toHaveBeenCalled()
		await mocks.after.mock.calls[0]?.[0]()
		expect(fetcher).toHaveBeenCalledTimes(2)
	})
	it('ignores other questions and invalid options; scheduler failure never escapes', () => {
		const logger = { info: vi.fn() }
		scheduleGoalInterestFact({ ...row, questionId: 'unrelated' }, logger)
		scheduleGoalInterestFact({ ...row, answer: 'invalid' }, logger)
		expect(mocks.after).not.toHaveBeenCalled()
		mocks.after.mockImplementationOnce(() => {
			throw new Error('no-context')
		})
		expect(() => scheduleGoalInterestFact(row, logger)).not.toThrow()
		expect(logger.info).toHaveBeenCalledWith('survey.interest_fact.failed', {
			rowId: 'response-1',
			reason: 'schedule-failed',
		})
	})
	it('accepts duplicate acknowledgements but rejects partial ones', async () => {
		const fact = goalInterestFact({ ...row, contactId: 'drovr-contact' })!
		await expect(
			recordInterestFacts({
				facts: [fact],
				config,
				fetcher: vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(
						Response.json({ inserted: 0, duplicates: 1, conflicts: [] }),
					),
			}),
		).resolves.toBeUndefined()
		await expect(
			recordInterestFacts({
				facts: [fact],
				config,
				fetcher: vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(
						Response.json({ inserted: 0, duplicates: 0, conflicts: [] }),
					),
			}),
		).rejects.toThrow('interest-fact-not-acknowledged')
	})
})
