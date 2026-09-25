import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
	const courseBuilderPOST = vi.fn()
	const recordSignupAttribution = vi.fn().mockResolvedValue('captured')
	const createShortlinkAttribution = vi.fn().mockResolvedValue(undefined)
	const inngestSend = vi.fn().mockResolvedValue(undefined)
	const issueRecoveryToken = vi.fn().mockResolvedValue(undefined)
	const reconcile = vi.fn()
	const cookieGet = vi.fn()
	const resolveDoi = vi.fn()
	const env: Record<string, string | undefined> = {
		CONVERTKIT_API_SECRET: 'secret',
		CONVERTKIT_API_KEY: 'key',
	}
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
		resolveDoi,
		env,
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

vi.mock('@/env.mjs', () => ({ env: mocks.env }))

vi.mock('@/db', () => ({ db: {} }))

vi.mock('@/lib/subscriber-marketing/drovr-doi-signup', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('@/lib/subscriber-marketing/drovr-doi-signup')
	>()),
	resolveDoiSignupContact: mocks.resolveDoi,
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

import { CourseBuilder } from '@coursebuilder/server/http'

import { POST } from './route'

function subscriberResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function request(
	body: Record<string, unknown>,
	timeZone: string | null = 'Asia/Tokyo',
) {
	return new NextRequest(
		'http://localhost/api/coursebuilder/subscribe-to-list/convertkit',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(timeZone ? { 'x-vercel-ip-timezone': timeZone } : {}),
			},
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
	process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED = 'true'
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

afterEach(() => {
	delete process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED
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

	it('keeps Skills Inngest send without minting recovery authorization from public signup', async () => {
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
		expect(mocks.issueRecoveryToken).not.toHaveBeenCalled()
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'skills-newsletter/subscribed',
				data: expect.objectContaining({
					email: 'skills@example.com',
					formId: 9376133,
					kitSubscriberId: '99',
					deadlineTimeZone: {
						type: 'BrowserEntryHeader',
						headerName: 'x-vercel-ip-timezone',
						timeZone: 'Asia/Tokyo',
						capturedAt: expect.any(String),
					},
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

	it('keeps course-entry evidence inactive until the rollout flag is enabled', async () => {
		delete process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 101,
				email_address: 'disabled@example.com',
				state: 'active',
				fields: {},
			}),
		)
		mocks.reconcile.mockResolvedValue({ status: 'active' })

		const response = await POST(
			request({
				email: 'disabled@example.com',
				listId: 9376133,
				fields: { source: 'aihero_skills_page' },
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.not.objectContaining({ deadlineTimeZone: expect.anything() }),
			}),
		)
	})

	it.each([
		[null, 'header-missing'],
		['not-a-zone', 'header-invalid'],
	] as const)(
		'records %s as explicit Pacific course-entry evidence',
		async (timeZone, reason) => {
			mocks.courseBuilderPOST.mockResolvedValue(
				subscriberResponse({
					id: 100,
					email_address: 'fallback@example.com',
					state: 'active',
					fields: {},
				}),
			)
			mocks.reconcile.mockResolvedValue({ status: 'active' })

			const response = await POST(
				request(
					{
						email: 'fallback@example.com',
						listId: 9376133,
						fields: { source: 'aihero_skills_page' },
					},
					timeZone,
				),
			)

			expect(response.status).toBe(200)
			expect(mocks.inngestSend).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						deadlineTimeZone: {
							type: 'ExplicitFallback',
							reason,
							timeZone: 'America/Los_Angeles',
							capturedAt: expect.any(String),
						},
					}),
				}),
			)
		},
	)

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

describe('drovr double opt-in (DROVR_DOI_FORMS)', () => {
	const drovrOn = (forms: string) => {
		mocks.env.DROVR_DOI_FORMS = forms
		mocks.env.DROVR_API_BASE_URL = 'https://drovr.test'
		mocks.env.DROVR_API_KEY_ORG_AIHERO = 'drovr_key'
	}
	const kitAccepts = () =>
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 4310000001,
				email_address: 'reader@example.com',
				state: 'active',
				fields: {},
			}),
		)
	const signup = (email = 'reader@example.com', listId = 9376133) =>
		POST(
			new NextRequest(
				'https://www.aihero.dev/api/coursebuilder/subscribe-to-list/convertkit',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						referer: 'https://www.aihero.dev/skills',
					},
					body: JSON.stringify({ email, name: 'Reader', listId }),
				},
			),
		)
	const drovrEvents = () =>
		mocks.inngestSend.mock.calls.filter(
			([event]) => event?.name === 'drovr/signup.requested',
		)

	beforeEach(() => {
		vi.clearAllMocks()
		// Active, so the Kit path stays inside the mocks (no attribution stash).
		mocks.reconcile.mockResolvedValue({
			status: 'active',
			removedUnsubscribeTag: false,
		})
		mocks.inngestSend.mockResolvedValue(undefined)
		mocks.resolveDoi.mockResolvedValue({ contactId: 'contact-doi-1' })
		for (const key of [
			'DROVR_DOI_FORMS',
			'DROVR_API_BASE_URL',
			'DROVR_API_KEY_ORG_AIHERO',
		])
			delete mocks.env[key]
	})

	it('flag off: the Skills signup takes the Kit path, and drovr hears nothing', async () => {
		kitAccepts()
		const response = await signup()

		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(response.status).toBe(200)
		expect(mocks.resolveDoi).not.toHaveBeenCalled()
		expect(drovrEvents()).toEqual([])
	})

	it.each([
		['another address during the canary', '9376133:canary@example.com', 'reader@example.com', 9376133],
		['another form', '9376133', 'reader@example.com', 1234],
	])('flag on for %s: still the Kit path', async (_, forms, email, listId) => {
		drovrOn(forms)
		kitAccepts()
		await signup(email, listId)

		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(mocks.resolveDoi).not.toHaveBeenCalled()
		expect(drovrEvents()).toEqual([])
	})

	it('flag on without drovr configured: the Kit path (never a stranded signup)', async () => {
		mocks.env.DROVR_DOI_FORMS = '9376133'
		kitAccepts()
		await signup()

		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(drovrEvents()).toEqual([])
	})

	it('flag on for this address: no Kit subscribe, one durable drovr signup, "check your email"', async () => {
		drovrOn('9376133:Reader@Example.com')
		const response = await signup()

		expect(mocks.courseBuilderPOST).not.toHaveBeenCalled()
		expect(mocks.reconcile).not.toHaveBeenCalled()
		expect(mocks.resolveDoi).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'reader@example.com',
				name: 'Reader',
				drovrFormId: 'skills-newsletter',
			}),
		)
		const sent = drovrEvents()
		expect(sent).toHaveLength(1)
		expect(sent[0]?.[0]).toMatchObject({
			id: expect.stringMatching(/^drovr-signup:/),
			data: {
				tenantId: 'org-aihero',
				contactId: 'contact-doi-1',
				formId: 'skills-newsletter',
				source: { page: 'https://www.aihero.dev/skills' },
			},
		})
		// No value-path entry: drovr births the course on confirmation.
		expect(
			mocks.inngestSend.mock.calls.filter(
				([event]) => event?.name === 'skills-newsletter/subscribed',
			),
		).toEqual([])
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			email_address: 'reader@example.com',
			first_name: 'Reader',
			state: 'awaiting-confirmation',
			fields: {},
		})
	})

	it('answers 502 when the drovr path fails, and never falls back to Kit', async () => {
		drovrOn('9376133')
		mocks.resolveDoi.mockRejectedValue(new Error('database unavailable'))
		const response = await signup()

		expect(response.status).toBe(502)
		expect(mocks.courseBuilderPOST).not.toHaveBeenCalled()
		expect(drovrEvents()).toEqual([])
		expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(
			'reader@example.com',
		)
	})
})
