import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
	const courseBuilderPOST = vi.fn()
	const recordSignupAttribution = vi.fn().mockResolvedValue('captured')
	const createShortlinkAttribution = vi.fn().mockResolvedValue(undefined)
	const inngestSend = vi.fn().mockResolvedValue(undefined)
	const issueRecoveryToken = vi.fn().mockResolvedValue(undefined)
	const reconcile = vi.fn()
	const cookieGet = vi.fn()
	const log = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}

	return {
		courseBuilderPOST,
		recordSignupAttribution,
		createShortlinkAttribution,
		inngestSend,
		issueRecoveryToken,
		reconcile,
		cookieGet,
		log,
	}
})

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: mocks.cookieGet,
	}),
}))

vi.mock('@/coursebuilder/course-builder-config', () => ({
	POST: mocks.courseBuilderPOST,
}))

vi.mock('@/env.mjs', () => ({
	env: {
		CONVERTKIT_API_SECRET: 'secret',
		CONVERTKIT_API_KEY: 'key',
	},
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		send: mocks.inngestSend,
	},
}))

vi.mock('@/lib/shortlinks-query', () => ({
	createShortlinkAttribution: mocks.createShortlinkAttribution,
}))

vi.mock('@/lib/signup-attribution', () => ({
	recordSignupAttribution: mocks.recordSignupAttribution,
}))

vi.mock('@/lib/subscriber-marketing/ai-hero-email-opt-in.server', () => ({
	reconcileAiHeroEmailOptInWithKit: mocks.reconcile,
}))

vi.mock(
	'@/lib/subscriber-marketing/skills-course-recovery-token.server',
	() => ({ issueSkillsCourseRecoveryToken: mocks.issueRecoveryToken }),
)

vi.mock('@/server/logger', () => ({
	log: mocks.log,
	createRequestContext: () => ({}),
	serializeError: (error: unknown) =>
		error instanceof Error ? error.message : String(error),
	withLogContext: async (_ctx: unknown, fn: () => Promise<Response>) => fn(),
}))

vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: (req: NextRequest) => Promise<Response>) => handler,
}))

import { KitSubscribeError } from '@/coursebuilder/email-list-provider'

import { CourseBuilder } from '@coursebuilder/core'

import { POST } from './route'

function subscriberResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function request(body: Record<string, unknown>) {
	return new NextRequest(
		'http://localhost/api/coursebuilder/subscribe-to-list/convertkit',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
	)
}

function useRealCourseBuilderFailureBoundary(error: Error) {
	mocks.courseBuilderPOST.mockImplementation((req: Request) =>
		CourseBuilder(req, {
			baseUrl: 'http://localhost',
			basePath: '/api/coursebuilder',
			authConfig: {} as never,
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
			adapter: {
				getUserByEmail: async (email: string) => ({
					id: 'user-1',
					email,
					name: 'Reader',
					emailVerified: null,
				}),
			} as never,
			providers: [
				{
					id: 'convertkit',
					name: 'Convertkit',
					type: 'email-list',
					defaultListType: 'form',
					defaultListId: 'default-form',
					options: {},
					subscribeToList: async () => {
						throw error
					},
				} as never,
			],
		}),
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.recordSignupAttribution.mockResolvedValue('captured')
	mocks.createShortlinkAttribution.mockResolvedValue(undefined)
	mocks.inngestSend.mockResolvedValue(undefined)
	mocks.issueRecoveryToken.mockResolvedValue(undefined)
	mocks.cookieGet.mockImplementation((name: string) => {
		if (name === 'ft_attr') {
			return {
				value: JSON.stringify({
					landing_path: '/blog/post',
					referrer: 'https://www.google.com/',
					captured_at: '2026-07-25T12:00:00.000Z',
				}),
			}
		}
		return undefined
	})
})

describe('subscribe-to-list convertkit route attribution', () => {
	it('writes signup attribution for a non-Skills signup and returns 200', async () => {
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 42,
				email_address: 'reader@example.com',
				state: 'active',
				fields: {},
			}),
		)

		const response = await POST(
			request({
				email: 'reader@example.com',
				listId: 555,
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledWith({
			email: 'reader@example.com',
			formId: 555,
			kitSubscriberId: 42,
			rawCookie: expect.stringContaining('/blog/post'),
		})
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('keeps Skills Inngest send and still writes the lean attribution row', async () => {
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 99,
				email_address: 'skills@example.com',
				state: 'active',
				fields: {},
			}),
		)
		mocks.reconcile.mockResolvedValue({ status: 'active' })

		const response = await POST(
			request({
				email: 'skills@example.com',
				listId: 9376133,
				fields: { source: 'aihero_skills_page' },
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.issueRecoveryToken).toHaveBeenCalledWith({
			kitSubscriberId: '99',
			email: 'skills@example.com',
		})
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'skills-newsletter/subscribed',
				data: expect.objectContaining({
					email: 'skills@example.com',
					formId: 9376133,
					kitSubscriberId: '99',
				}),
			}),
		)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledWith({
			email: 'skills@example.com',
			formId: 9376133,
			kitSubscriberId: 99,
			rawCookie: expect.any(String),
		})
	})

	it('keeps path entry when recovery token issuance fails', async () => {
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 99,
				email_address: 'skills@example.com',
				state: 'active',
				fields: {},
			}),
		)
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.issueRecoveryToken.mockRejectedValue(new Error('token unavailable'))

		const response = await POST(
			request({
				email: 'skills@example.com',
				listId: 9376133,
				fields: { source: 'aihero_skills_page' },
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'skills.course.recovery_token_issue_failed',
			{ outcome: 'not-issued' },
		)
	})

	it('returns 200 when attribution insert fails', async () => {
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 7,
				email_address: 'reader@example.com',
				state: 'active',
				fields: {},
			}),
		)
		mocks.recordSignupAttribution.mockRejectedValueOnce(new Error('db down'))

		const response = await POST(
			request({
				email: 'reader@example.com',
				listId: 555,
			}),
		)

		expect(response.status).toBe(200)
		await vi.waitFor(() => {
			expect(mocks.log.error).toHaveBeenCalledWith(
				'signup.attribution.failed',
				expect.objectContaining({ formId: '555', error: 'db down' }),
			)
		})
	})

	it('subscribes to the Skills course when there is no ft_attr cookie', async () => {
		mocks.cookieGet.mockReturnValue(undefined)
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 7,
				email_address: 'reader@example.com',
				state: 'active',
				fields: {},
			}),
		)

		const response = await POST(
			request({
				email: 'reader@example.com',
				listId: 9376133,
				fields: { source: 'skill_page_course:skills-handoff' },
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledWith({
			email: 'reader@example.com',
			formId: 9376133,
			kitSubscriberId: 7,
			rawCookie: undefined,
		})
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					source: 'skill_page_course:skills-handoff',
					optInAttribution: undefined,
				}),
			}),
		)
	})

	it('writes formId default when the body has no listId and still returns 200', async () => {
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 42,
				email_address: 'reader@example.com',
				state: 'active',
				fields: {},
			}),
		)

		const response = await POST(
			request({
				email: 'reader@example.com',
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledWith({
			email: 'reader@example.com',
			formId: undefined,
			kitSubscriberId: 42,
			rawCookie: expect.stringContaining('/blog/post'),
		})
	})

	// The regression that sent readers "Something went wrong." AFTER Kit had
	// accepted them. Everything in the Skills branch is post-processing, so a
	// throw there used to surface as a 500 and the form rendered its default
	// error over a subscription that had in fact succeeded.
	//
	// One test per stage that can throw, because they fail for different reasons
	// and only the enqueue one has a reconciler behind it.
	it.each([
		[
			'reconcile throws',
			() => mocks.reconcile.mockRejectedValue(new Error('kit unreachable')),
		],
		[
			'inngest send throws',
			() => {
				mocks.reconcile.mockResolvedValue({ status: 'active' })
				mocks.inngestSend.mockRejectedValue(new Error('inngest down'))
			},
		],
	])(
		'still returns 200 to a subscribed reader when %s',
		async (_label, arrange) => {
			mocks.courseBuilderPOST.mockResolvedValue(
				subscriberResponse({
					id: 99,
					email_address: 'skills@example.com',
					state: 'active',
					fields: {},
				}),
			)
			arrange()

			const response = await POST(
				request({
					email: 'skills@example.com',
					listId: 9376133,
					fields: { source: 'aihero_skills_page' },
				}),
			)

			expect(response.status).toBe(200)
			expect(mocks.log.error).toHaveBeenCalledWith(
				'skills.newsletter.path-entry.enqueue.failed',
				expect.objectContaining({ formId: 9376133 }),
			)
		},
	)

	it.each([
		['rate-limited', 429, null],
		['upstream', 502, null],
		['unresolved', 502, null],
		['rejected', 400, null],
	] as const)(
		'maps real Course Builder %s failures to HTTP %s',
		async (code, status, retryAfter) => {
			useRealCourseBuilderFailureBoundary(
				new KitSubscribeError({
					code,
					status: code === 'rate-limited' ? 429 : undefined,
				}),
			)

			const response = await POST(
				request({ email: 'reader@example.com', listId: 555 }),
			)

			expect(response.status).toBe(status)
			expect(response.headers.get('retry-after')).toBe(retryAfter)
			expect(mocks.inngestSend).not.toHaveBeenCalled()
			expect(mocks.recordSignupAttribution).not.toHaveBeenCalled()
			expect(mocks.log.warn).toHaveBeenCalledWith('kit.subscribe.failed', {
				context: 'coursebuilder-subscribe-route',
				reason: code,
			})
		},
	)
})
