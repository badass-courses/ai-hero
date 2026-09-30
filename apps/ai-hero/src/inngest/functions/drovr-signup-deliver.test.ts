import { NonRetriableError } from 'inngest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	capture: vi.fn(),
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
}))

vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({
	captureDrovrOutboxLive: mocks.capture,
}))

import { drovrSignupDeliver, outboxFailedSignup } from './drovr-signup-deliver'

type Handler = (input: {
	event: { data: Record<string, unknown> }
	step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }
	attempt?: number
	maxAttempts?: number
}) => Promise<unknown>
const handler = (drovrSignupDeliver as unknown as { handler: Handler }).handler
const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }
const event = {
	data: {
		tenantId: 'org-aihero',
		contactId: 'contact-1',
		formId: 'skills-newsletter',
		occurredAt: '2026-09-25T07:00:00.000Z',
		submissionId: 'submission-1',
		source: { page: 'https://www.aihero.dev/skills' },
	},
}

beforeEach(() => {
	vi.clearAllMocks()
	Object.assign(mocks.env, {
		DROVR_DOI_FORMS: '9376133',
		DROVR_API_BASE_URL: 'https://drovr.test',
		DROVR_API_KEY_ORG_AIHERO: 'drovr_key',
	})
	vi.unstubAllGlobals()
})

describe('drovr-signup-deliver (owns the retry of POST /signups)', () => {
	it('is its own durable function with retries', () => {
		const fn = drovrSignupDeliver as unknown as {
			config: unknown
			trigger: unknown
		}
		expect(fn.config).toMatchObject({
			id: 'drovr-signup-deliver-v1',
			retries: 8,
		})
		expect(fn.trigger).toEqual({ event: 'drovr/signup.requested' })
	})

	it('records the signup and logs drovr answer, without the address', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ status: 'awaiting-confirmation' })),
		)
		await expect(handler({ event, step })).resolves.toEqual({
			status: 'awaiting-confirmation',
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.signup.recorded',
			expect.objectContaining({
				contactId: 'contact-1',
				status: 'awaiting-confirmation',
			}),
		)
	})

	it('rethrows a retryable failure so Inngest retries', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 503 })),
		)
		await expect(handler({ event, step })).rejects.not.toBeInstanceOf(
			NonRetriableError,
		)
	})

	it('ends with NonRetriableError on a permanent refusal, and logs it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json(
					{ type: 'urn:drovr:problem:unknown-form' },
					{ status: 422 },
				),
			),
		)
		await expect(handler({ event, step })).rejects.toBeInstanceOf(
			NonRetriableError,
		)
		expect(mocks.log.error).toHaveBeenCalledWith(
			'drovr.signup.refused',
			expect.objectContaining({ httpStatus: 422 }),
		)
	})

	it('still delivers a queued signup after DROVR_DOI_FORMS is turned off', async () => {
		delete mocks.env.DROVR_DOI_FORMS
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ status: 'awaiting-confirmation' })),
		)
		await expect(handler({ event, step })).resolves.toEqual({
			status: 'awaiting-confirmation',
		})
	})

	it('keeps retrying while the deployment has no drovr config (never drops a taken signup)', async () => {
		delete mocks.env.DROVR_API_KEY_ORG_AIHERO
		await expect(handler({ event, step })).rejects.toThrow(/not configured/)
	})
})

describe('row 204: a drovr 5xx never loses a signup', () => {
	const respond = (status: number, headers: Record<string, string> = {}) =>
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({}), { status, headers })),
		)

	beforeEach(() => {
		mocks.capture.mockImplementation(async (entries: unknown[]) => ({
			status: 'outboxed',
			count: entries.length,
		}))
	})

	it.each([500, 503])(
		'retries a %i with RetryAfterError, honouring a longer Retry-After',
		async (status) => {
			respond(status, { 'retry-after': '300' })
			await expect(
				handler({ event, step, attempt: 0, maxAttempts: 9 }),
			).rejects.toMatchObject({ name: 'RetryAfterError', retryAfter: '300' })
			expect(mocks.capture).not.toHaveBeenCalled()
		},
	)

	it.each([500, 503])(
		'outboxes the signup on the last attempt of a %i and completes',
		async (status) => {
			respond(status)
			expect(
				await handler({ event, step, attempt: 8, maxAttempts: 9 }),
			).toEqual({ status: 'outboxed' })
			expect(mocks.capture).toHaveBeenCalledWith(
				[
					expect.objectContaining({
						endpoint: 'signups',
						idempotencyKey: 'submission-1',
						body: event.data,
						source: 'signup',
					}),
				],
				expect.objectContaining({ httpStatus: status }),
			)
		},
	)

	it('never outboxes a refusal, even on the last attempt', async () => {
		respond(422)
		await expect(
			handler({ event, step, attempt: 8, maxAttempts: 9 }),
		).rejects.toBeInstanceOf(NonRetriableError)
		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it('backstops a dead run from onFailure, but never a refusal', async () => {
		await outboxFailedSignup(
			event.data as never,
			{ name: 'Error' },
			mocks.capture,
		)
		expect(mocks.capture).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					source: 'onFailure',
					idempotencyKey: 'submission-1',
				}),
			],
			expect.anything(),
		)
		mocks.capture.mockClear()
		await outboxFailedSignup(
			event.data as never,
			{ name: 'NonRetriableError' },
			mocks.capture,
		)
		expect(mocks.capture).not.toHaveBeenCalled()
	})
})
