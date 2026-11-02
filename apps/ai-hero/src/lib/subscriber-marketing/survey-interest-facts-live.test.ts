import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
	send: vi.fn(),
}))
vi.mock('next/server', () => ({ after: mocks.after }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: mocks.send } }))
import {
	recordGoalInterestFact,
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
		await expect(
			recordGoalInterestFact({ row, config, fetcher }),
		).resolves.toBe('recorded')
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
		'throws on %s failure so the Inngest step retries',
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
			await expect(
				recordGoalInterestFact({ row, config, fetcher }),
			).rejects.toThrow()
		},
	)
	it('a 503 on the first attempt retries and records once; the retry sends the same fact', async () => {
		const bodies: string[] = []
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
			async (url, init) => {
				if (String(url).endsWith('/resolve_contacts'))
					return resolutionResponse()
				bodies.push(String(init?.body))
				return bodies.length === 1
					? new Response('down', { status: 503 })
					: acceptedResponse()
			},
		)
		await expect(
			recordGoalInterestFact({ row, config, fetcher }),
		).rejects.toThrow('interest-fact-http-failed')
		await expect(
			recordGoalInterestFact({ row, config, fetcher }),
		).resolves.toBe('recorded')
		expect(bodies).toHaveLength(2)
		expect(bodies[1]).toBe(bodies[0])
	})
	it('a repeated answer sends the same sourceId, so drovr dedupes it', async () => {
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
			async (url) =>
				String(url).endsWith('/resolve_contacts')
					? resolutionResponse()
					: Response.json({ inserted: 0, duplicates: 1, conflicts: [] }),
		)
		await expect(
			recordGoalInterestFact({ row, config, fetcher }),
		).resolves.toBe('recorded')
		const fact = (n: number) =>
			JSON.parse(String(fetcher.mock.calls[n]?.[1]?.body)).facts?.[0]
		await recordGoalInterestFact({ row, config, fetcher })
		expect(fact(3)).toEqual(fact(1))
		expect(fact(1).sourceId).toBe(
			JSON.stringify(['aihero', 'AI_QuestionResponse', 'response-1']),
		)
	})
	it('does not post for a missing/conflicting contact or missing email', async () => {
		for (const status of ['missing', 'conflict']) {
			const fetcher = vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockResolvedValue(Response.json({ results: [{ index: 0, status }] }))
			await expect(
				recordGoalInterestFact({ row, config, fetcher }),
			).resolves.toBe('unresolved')
			expect(fetcher).toHaveBeenCalledTimes(1)
		}
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
		await expect(
			recordGoalInterestFact({ row: { ...row, email: null }, config, fetcher }),
		).resolves.toBe('missing-email')
		expect(fetcher).not.toHaveBeenCalled()
	})
	it('sends the Inngest event after the response and never POSTs to drovr directly', async () => {
		const fetcher = vi.fn()
		vi.stubGlobal('fetch', fetcher)
		mocks.send.mockResolvedValue({ ids: ['x'] })
		scheduleGoalInterestFact(row, { info: vi.fn() })
		expect(mocks.after).toHaveBeenCalledOnce()
		expect(mocks.send).not.toHaveBeenCalled()
		await mocks.after.mock.calls[0]?.[0]()
		expect(fetcher).not.toHaveBeenCalled()
		expect(mocks.send).toHaveBeenCalledWith({
			id: 'survey-goal-fact:response-1',
			name: 'aihero/interest.fact.requested',
			data: {
				email: 'HUMAN@example.test',
				fieldKey: 'survey_goal:response-1',
				expressedAt: '2026-10-28T17:20:00.000Z',
				via: 'survey',
				survey: {
					rowId: 'response-1',
					questionId: GOAL_QUESTION_ID,
					answer: 'team_workflows',
				},
			},
		})
	})
	it('a failed send is logged, never thrown', async () => {
		mocks.send.mockRejectedValue(new Error('down'))
		const logger = { info: vi.fn() }
		scheduleGoalInterestFact(row, logger)
		await expect(mocks.after.mock.calls[0]?.[0]()).resolves.toBeUndefined()
		expect(logger.info).toHaveBeenCalledWith('survey.interest_fact.failed', {
			rowId: 'response-1',
			reason: 'enqueue-failed',
		})
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
