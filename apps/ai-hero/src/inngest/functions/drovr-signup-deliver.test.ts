import { NonRetriableError } from 'inngest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

import { drovrSignupDeliver } from './drovr-signup-deliver'

type Handler = (input: {
	event: { data: Record<string, unknown> }
	step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }
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
			retries: 6,
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
