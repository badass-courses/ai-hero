import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: {
		DROVR_EXECUTOR_TOKEN: 'test-executor-token-1234567890',
		AI_HERO_VALUE_PATH_TOKEN_SECRET: 'test-token-secret-123456',
		NEXT_PUBLIC_URL: 'https://www.aihero.dev',
	},
	personalize: vi.fn(),
	select: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/db', () => ({ db: { select: mocks.select } }))
vi.mock('@/db/schema', () => ({
	providerIdentity: {
		externalId: 'externalId',
		contactId: 'contactId',
		provider: 'provider',
	},
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	getValuePathAnswerPages: async () => [],
}))
vi.mock('@/lib/subscriber-marketing/drovr-personalize', async () => {
	const actual = await vi.importActual<
		typeof import('@/lib/subscriber-marketing/drovr-personalize')
	>('@/lib/subscriber-marketing/drovr-personalize')
	return { ...actual, personalizeDrovrIntent: mocks.personalize }
})

import { log } from '@/server/logger'
import { POST } from './route'

const body = {
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	emailKey: 'ai-hero-skills-workflow.email-0',
	idempotencyKey: 'intent-1',
	dueAt: '2026-09-24T18:00:00.000Z',
}
const post = (input: unknown, token?: string) =>
	POST(
		new NextRequest('https://www.aihero.dev/api/drovr/personalize', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(input),
		}),
	)

describe('POST /api/drovr/personalize', () => {
	beforeEach(() => {
		mocks.personalize.mockReset()
		mocks.select.mockReset()
		mocks.select.mockReturnValue({
			from: () => ({
				where: () => ({ limit: async () => [{ externalId: 'kit-1' }] }),
			}),
		})
	})
	it('rejects a wrong token and any non-authority tenant before reading private data', async () => {
		const unauthorized = await post(body)
		expect(unauthorized.status).toBe(401)
		expect(await unauthorized.json()).toMatchObject({
			type: 'urn:aihero:problem:unauthorized',
		})
		const shadow = await post(
			{ ...body, tenantId: 'org-aihero-shadow' },
			'test-executor-token-1234567890',
		)
		expect(shadow.status).toBe(403)
		expect(shadow.headers.get('content-type')).toBe('application/problem+json')
		expect(await shadow.json()).toMatchObject({
			type: 'urn:aihero:problem:tenant-mismatch',
			status: 403,
		})
		expect(mocks.select).not.toHaveBeenCalled()
		expect(mocks.personalize).not.toHaveBeenCalled()
	})
	it('answers a valid read-only request with the personalization result', async () => {
		mocks.personalize.mockResolvedValue({
			email: 'ada@example.com',
			firstName: 'Ada',
			variables: {},
			sendable: true,
			reasons: [],
			flags: ['contact-provisional'],
		})
		const response = await post(body, 'test-executor-token-1234567890')
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			sendable: true,
			flags: ['contact-provisional'],
			email: 'ada@example.com',
		})
		expect(mocks.personalize).toHaveBeenCalledWith(
			expect.objectContaining({
				request: body,
				kitSubscriberId: 'kit-1',
				pathTokenSecret: 'test-token-secret-123456',
			}),
		)
	})
	it('logs one answered line with the decision and no email, name or variables', async () => {
		const info = vi.spyOn(log, 'info')
		mocks.personalize.mockResolvedValue({
			email: 'ada@example.com',
			firstName: 'Ada',
			variables: { answer_url: 'https://www.aihero.dev/a?pt=secret-token' },
			sendable: false,
			reasons: ['old-newsletter-exit-unconfirmed'],
			flags: ['contact-provisional'],
		})
		await post(body, 'test-executor-token-1234567890')
		const answered = info.mock.calls.filter(([event]) => event === 'drovr.personalize.answered')
		expect(answered).toEqual([[
			'drovr.personalize.answered',
			{
				journeyId: body.journeyId,
				emailKey: body.emailKey,
				contactId: 'contact-1',
				contactFound: true,
				sendable: false,
				reasons: ['old-newsletter-exit-unconfirmed'],
				flags: ['contact-provisional'],
			},
		]])
		const logged = JSON.stringify(answered)
		for (const value of ['ada@example.com', 'Ada', 'secret-token', 'answer_url'])
			expect(logged).not.toContain(value)
		info.mockRestore()
	})
	it('answers the same status and body when the answered log throws', async () => {
		const info = log.info
		const spy = vi.spyOn(log, 'info').mockImplementation((event, data) => {
			if (event === 'drovr.personalize.answered') throw new Error('sink down')
			return info(event, data)
		})
		const answer = { email: 'ada@example.com', firstName: 'Ada', variables: {}, sendable: true, reasons: [], flags: [] }
		mocks.personalize.mockResolvedValue(answer)
		const response = await post(body, 'test-executor-token-1234567890')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(answer)
		mocks.personalize.mockResolvedValue(undefined)
		expect((await post(body, 'test-executor-token-1234567890')).status).toBe(404)
		expect(spy).toHaveBeenCalledWith('drovr.personalize.answered', expect.objectContaining({ contactFound: false }))
		spy.mockRestore()
	})
	it('marks duplicate Kit identities as a conflict instead of picking one', async () => {
		mocks.select.mockReturnValue({
			from: () => ({ where: () => ({ limit: async () => [
				{ externalId: 'kit-1' }, { externalId: 'kit-2' },
			] }) }),
		})
		mocks.personalize.mockResolvedValue({ sendable: false, reasons: ['identity-conflict'], variables: {} })
		await post(body, 'test-executor-token-1234567890')
		expect(mocks.personalize).toHaveBeenCalledWith(expect.objectContaining({ identityConflict: true, kitSubscriberId: undefined }))
	})

	it('answers unknown contact with a 404 problem, the status drovr branches on', async () => {
		mocks.personalize.mockResolvedValue(undefined)
		const response = await post(body, 'test-executor-token-1234567890')
		expect(response.status).toBe(404)
		expect(response.headers.get('content-type')).toBe('application/problem+json')
		expect(await response.json()).toMatchObject({
			type: 'urn:aihero:problem:unknown-contact',
			status: 404,
		})
	})
})
