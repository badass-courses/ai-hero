import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: {
		AIHERO_TEST_PRINCIPAL_TOKEN: 'test-principal-token-0123456789abcdef',
		AI_HERO_VALUE_PATH_TOKEN_SECRET: 'test-token-secret-123456',
	} as Record<string, string | undefined>,
	mint: vi.fn(),
	remove: vi.fn(),
	personalize: vi.fn(),
	answerPages: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/server/logger', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/server/logger')>()),
	log: mocks.log,
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/drovr-personalize', () => ({
	personalizeDrovrIntent: mocks.personalize,
}))
vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	getValuePathAnswerPages: mocks.answerPages,
}))
vi.mock('@/lib/test-principals/test-principal-store', () => ({
	mintTestPrincipalRecords: mocks.mint,
	deleteTestPrincipalRecords: mocks.remove,
}))

import { hashVerificationToken, testPrincipalIdentity } from '@/lib/test-principals/test-principal'

import { DELETE } from './[principalId]/route'
import { POST } from './route'

const identity = testPrincipalIdentity('run-12345678')
const createdAt = new Date('2026-09-25T00:00:00.000Z')
const body = {
	runId: 'run-12345678',
	tenantId: 'org-aihero',
	personas: ['recipient'],
	emailKeys: ['email-1'],
}
const post = (payload: unknown, token = mocks.env.AIHERO_TEST_PRINCIPAL_TOKEN) =>
	POST(
		new NextRequest('https://www.aihero.dev/api/drovr/test-principals', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: typeof payload === 'string' ? payload : JSON.stringify(payload),
		}),
	)
const del = (principalId: string, token = mocks.env.AIHERO_TEST_PRINCIPAL_TOKEN) =>
	DELETE(
		new NextRequest(`https://www.aihero.dev/api/drovr/test-principals/${principalId}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		}),
		{ params: Promise.resolve({ principalId }) },
	)

beforeEach(() => {
	vi.clearAllMocks()
	mocks.env.AIHERO_TEST_PRINCIPAL_TOKEN = 'test-principal-token-0123456789abcdef'
	vi.stubEnv('AUTH_SECRET', 'auth-secret-for-tests')
	mocks.answerPages.mockResolvedValue([])
	mocks.personalize.mockResolvedValue({ variables: { answer_1_url: 'https://www.aihero.dev/ask/x?pt=t' } })
	mocks.mint.mockResolvedValue({
		status: 'minted',
		identity,
		createdAt,
		expiresAt: new Date(createdAt.getTime() + 3_600_000),
	})
})

describe('POST /api/drovr/test-principals', () => {
	it('answers 503 problem+json when the token is not configured', async () => {
		mocks.env.AIHERO_TEST_PRINCIPAL_TOKEN = undefined
		const response = await post(body, 'anything')
		expect(response.status).toBe(503)
		expect(response.headers.get('content-type')).toBe('application/problem+json')
		expect(mocks.mint).not.toHaveBeenCalled()
	})

	it('refuses a wrong bearer, a malformed body, another tenant, and the T3c coupon', async () => {
		expect((await post(body, 'wrong-token')).status).toBe(401)
		expect((await post('{not json')).status).toBe(400)
		expect((await post({ ...body, runId: 'x' })).status).toBe(400)
		expect((await post({ ...body, tenantId: 'org-aihero-shadow' })).status).toBe(403)
		expect((await post({ ...body, evergreenCoupon: 'crash-course' })).status).toBe(501)
		expect(mocks.mint).not.toHaveBeenCalled()
	})

	it('mints a principal with a one-time sign-in the real Auth.js hash will accept', async () => {
		const response = await post(body)
		expect(response.status).toBe(201)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const json = await response.json()
		expect(json).toMatchObject({
			principalId: identity.principalId,
			contactId: identity.contactId,
			email: identity.email,
			expiresAt: '2026-09-25T01:00:00.000Z',
			variables: { 'email-1': { answer_1_url: 'https://www.aihero.dev/ask/x?pt=t' } },
			signIn: { confirm: { method: 'POST', path: '/api/auth/magic-link/confirm' } },
		})
		const raw = new URL(json.signIn.url).searchParams.get('token')!
		const [{ tokenHash, runId }] = mocks.mint.mock.calls[0]!.slice(1) as [
			{ tokenHash: string; runId: string },
		]
		expect(runId).toBe('run-12345678')
		expect(tokenHash).toBe(hashVerificationToken(raw, 'auth-secret-for-tests'))
		expect(mocks.personalize).toHaveBeenCalledWith(
			expect.objectContaining({
				request: expect.objectContaining({
					contactId: identity.contactId,
					emailKey: 'email-1',
					dueAt: createdAt.toISOString(),
				}),
			}),
		)
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.test_principal.minted',
			expect.objectContaining({ principalId: identity.principalId, status: 'minted' }),
		)
		expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(raw)
	})

	it('answers 200 for the existing principal and 429 past the live limit', async () => {
		mocks.mint.mockResolvedValueOnce({
			status: 'existing',
			identity,
			createdAt,
			expiresAt: new Date(createdAt.getTime() + 3_600_000),
		})
		expect((await post(body)).status).toBe(200)
		mocks.mint.mockResolvedValueOnce({ status: 'limit', live: 5 })
		const limited = await post(body)
		expect(limited.status).toBe(429)
		expect(await limited.json()).toMatchObject({
			type: 'urn:aihero:problem:test-principal-limit',
		})
	})
})

describe('DELETE /api/drovr/test-principals/{principalId}', () => {
	it('refuses a non-synthetic id before any read', async () => {
		const response = await del('user-real-1')
		expect(response.status).toBe(400)
		expect(mocks.remove).not.toHaveBeenCalled()
	})

	it('answers 401 without the bearer and 204 when nothing is there', async () => {
		expect((await del(identity.principalId, 'wrong')).status).toBe(401)
		mocks.remove.mockResolvedValueOnce(null)
		expect((await del(identity.principalId)).status).toBe(204)
	})

	it('returns the removal receipt and audits it', async () => {
		mocks.remove.mockResolvedValueOnce({
			identity,
			removed: { AI_User: 1, AI_Session: 1, Contact: 1 },
			absentTables: [],
		})
		const response = await del(identity.principalId)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			principalId: identity.principalId,
			removed: { AI_User: 1, AI_Session: 1, Contact: 1 },
			absentTables: [],
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.test_principal.deleted',
			expect.objectContaining({ principalId: identity.principalId, trigger: 'request' }),
		)
	})
})
