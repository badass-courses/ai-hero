import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
	const courseBuilderPOST = vi.fn()
	const redisGet = vi.fn().mockResolvedValue(false)
	const checkBotId = vi.fn().mockResolvedValue({ isBot: false })
	const recordSignupAttribution = vi.fn().mockResolvedValue('captured')
	const createShortlinkAttribution = vi.fn().mockResolvedValue(undefined)
	const inngestSend = vi.fn().mockResolvedValue(undefined)
	const issueRecoveryToken = vi.fn().mockResolvedValue(undefined)
	const reconcile = vi.fn()
	const cookieGet = vi.fn()
	const resolveDoi = vi.fn()
	const setFields = vi.fn().mockResolvedValue(undefined)
	const env: Record<string, string | undefined> = {
		NEXTAUTH_SECRET: 'synthetic-test-key',
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
		redisGet,
		checkBotId,
		recordSignupAttribution,
		createShortlinkAttribution,
		inngestSend,
		issueRecoveryToken,
		reconcile,
		cookieGet,
		resolveDoi,
		setFields,
		env,
		log,
	}
})

vi.mock('@coursebuilder/core/providers/convertkit', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('@coursebuilder/core/providers/convertkit')
	>()),
	setConvertkitSubscriberFields: mocks.setFields,
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: mocks.cookieGet,
	}),
}))

vi.mock('@/coursebuilder/course-builder-config', () => ({
	POST: mocks.courseBuilderPOST,
}))

vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/server/redis-client', () => ({ redis: { get: mocks.redisGet } }))
vi.mock('botid/server', () => ({ checkBotId: mocks.checkBotId }))

vi.mock('@/db', () => ({ db: {} }))

vi.mock(
	'@/lib/subscriber-marketing/drovr-doi-signup',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('@/lib/subscriber-marketing/drovr-doi-signup')
		>()),
		resolveDoiSignupContact: mocks.resolveDoi,
	}),
)

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
	mocks.redisGet.mockReset().mockResolvedValue(false)
	mocks.checkBotId.mockReset().mockResolvedValue({ isBot: false })
	process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED = 'true'
	process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED = 'true'
	mocks.recordSignupAttribution.mockResolvedValue('captured')
	mocks.createShortlinkAttribution.mockResolvedValue(undefined)
	mocks.inngestSend.mockResolvedValue(undefined)
	mocks.issueRecoveryToken.mockResolvedValue(undefined)
	mocks.setFields.mockReset().mockResolvedValue(undefined)
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
	delete process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED
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

	it('keeps course-entry evidence inactive while the capture switch is unset, even with exhaustion on', async () => {
		delete process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED
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
				data: expect.not.objectContaining({
					deadlineTimeZone: expect.anything(),
				}),
			}),
		)
	})

	it('captures the zone on its own switch, with the exhaustion flag off', async () => {
		delete process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED
		process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED = 'true'
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 102,
				email_address: 'capture@example.com',
				state: 'active',
				fields: {},
			}),
		)
		mocks.reconcile.mockResolvedValue({ status: 'active' })

		const response = await POST(
			request({
				email: 'capture@example.com',
				listId: 9376133,
				fields: { source: 'aihero_skills_page' },
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					deadlineTimeZone: expect.objectContaining({
						type: 'BrowserEntryHeader',
						timeZone: 'Asia/Tokyo',
					}),
				}),
			}),
		)
	})

	it('stashes the evidence in its own Kit call: a refusal leaves the attribution stash intact', async () => {
		delete process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED
		process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED = 'true'
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 103,
				email_address: 'unconfirmed@example.com',
				state: 'inactive',
				fields: {},
			}),
		)
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })
		mocks.setFields.mockImplementation(
			async ({ fields }: { fields: Record<string, string> }) => {
				if ('aih_course_entry_evidence' in fields)
					throw new Error('Kit refused the field')
			},
		)

		const response = await POST(
			request({
				email: 'unconfirmed@example.com',
				listId: 9376133,
				fields: { source: 'aihero_skills_page' },
			}),
		)

		expect(response.status).toBe(200)
		expect(mocks.setFields).toHaveBeenCalledTimes(2)
		expect(
			mocks.setFields.mock.calls.map(([args]) => Object.keys(args.fields)),
		).toEqual([['aih_optin_attribution'], ['aih_course_entry_evidence']])
		expect(mocks.log.info).toHaveBeenCalledWith(
			'skills.newsletter.confirmation.required',
			expect.objectContaining({ attributionStashed: true }),
		)
		expect(mocks.log.error).toHaveBeenCalledWith(
			'skills.course-entry-evidence.stash.failed',
			expect.objectContaining({ error: 'Kit refused the field' }),
		)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('writes no evidence field while capture is off, even with exhaustion on', async () => {
		delete process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED
		expect(process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED).toBe('true')
		mocks.courseBuilderPOST.mockResolvedValue(
			subscriberResponse({
				id: 104,
				email_address: 'off@example.com',
				state: 'inactive',
				fields: {},
			}),
		)
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })

		await POST(
			request({
				email: 'off@example.com',
				listId: 9376133,
				fields: { source: 'aihero_skills_page' },
			}),
		)

		expect(
			mocks.setFields.mock.calls.map(([args]) => Object.keys(args.fields)),
		).toEqual([['aih_optin_attribution']])
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
		[
			'another address during the canary',
			'9376133:canary@example.com',
			'reader@example.com',
			9376133,
		],
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

describe('subscribe bot defence', () => {
	const body = {
		email: 'Synthetic.Reader@example.test',
		name: 'aBcDeFgHiJ',
		listId: 555,
	}
	const humanResponse = {
		id: 123,
		email_address: body.email,
		first_name: body.name,
		state: 'inactive',
		fields: {},
	}
	const botEvents = () =>
		mocks.log.info.mock.calls.filter(([event]) =>
			event.startsWith('subscribe.bot_'),
		)
	const enable = (mode: 'shadow' | 'enforce') =>
		mocks.redisGet.mockImplementation(async (key: string) =>
			key.endsWith(`subscribe-bot-${mode}`),
		)

	beforeEach(() => {
		mocks.courseBuilderPOST.mockImplementation(async () =>
			subscriberResponse(humanResponse),
		)
	})

	it('off preserves response bytes, Kit request and writes over generated requests', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					name: fc.string(),
					listId: fc.integer({ min: 1, max: 9000 }),
					extra: fc.string(),
				}),
				async (generated) => {
					vi.clearAllMocks()
					const payload = { ...generated, email: body.email }
					const upstream = new Response('unchanged upstream bytes', {
						status: 418,
						headers: { 'x-synthetic': 'same' },
					})
					mocks.courseBuilderPOST.mockResolvedValueOnce(upstream)
					const response = await POST(request(payload))
					expect(response).toBe(upstream)
					expect(await response.text()).toBe('unchanged upstream bytes')
					expect(response.headers.get('x-synthetic')).toBe('same')
					expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
					expect(
						await mocks.courseBuilderPOST.mock.calls[0]![0].json(),
					).toEqual(payload)
					expect(mocks.checkBotId).not.toHaveBeenCalled()
					expect(botEvents()).toEqual([])
					expect(mocks.recordSignupAttribution).not.toHaveBeenCalled()
					expect(mocks.createShortlinkAttribution).not.toHaveBeenCalled()
					expect(mocks.inngestSend).not.toHaveBeenCalled()
				},
			),
			{ numRuns: 50 },
		)
	})

	it.each(['botid', 'random-name'] as const)(
		'enforce rejects %s before any Kit call or writes',
		async (reason) => {
			enable('enforce')
			mocks.checkBotId.mockResolvedValue({ isBot: true })
			const payload = {
				...body,
				name: reason === 'botid' ? 'Krzysztof' : body.name,
			}
			const response = await POST(request(payload))
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				email_address: body.email,
				first_name: payload.name,
				state: 'awaiting-confirmation',
				fields: {},
			})
			expect(mocks.courseBuilderPOST).not.toHaveBeenCalled()
			expect(mocks.recordSignupAttribution).not.toHaveBeenCalled()
			expect(mocks.createShortlinkAttribution).not.toHaveBeenCalled()
			expect(mocks.inngestSend).not.toHaveBeenCalled()
			expect(mocks.resolveDoi).not.toHaveBeenCalled()
			expect(botEvents()).toEqual([
				[
					'subscribe.bot_rejected',
					{
						mode: 'enforce',
						reason,
						emailHash: createHmac(
							'sha256',
							createHmac('sha256', 'synthetic-test-key')
								.update('subscribe-bot-v1')
								.digest(),
						)
							.update(body.email.trim().toLowerCase())
							.digest('hex')
							.slice(0, 16),
					},
				],
			])
			const serialized = JSON.stringify(botEvents())
			expect(serialized).not.toContain(body.email)
			expect(serialized).not.toContain(body.email.toLowerCase())
			expect(serialized).not.toContain(payload.name)
		},
	)

	it('shadow records a would-block but preserves the complete normal signup', async () => {
		enable('shadow')
		mocks.checkBotId.mockResolvedValue({ isBot: true })
		const response = await POST(request(body))
		expect(await response.json()).toEqual(humanResponse)
		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledTimes(1)
		expect(botEvents()[0]).toEqual([
			'subscribe.bot_would_block',
			expect.objectContaining({ reason: 'random-name', mode: 'shadow' }),
		])
	})

	it('never rejects a random-looking name without BotID suspicion', async () => {
		enable('enforce')
		await POST(request(body))
		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(botEvents()[0]).toEqual([
			'subscribe.bot_allowed',
			expect.objectContaining({ reason: 'human' }),
		])
	})

	it('fails open on BotID errors, with its own countable reason and no error text', async () => {
		enable('enforce')
		mocks.checkBotId.mockRejectedValue(new Error(body.email))
		const response = await POST(request(body))
		expect(await response.json()).toEqual(humanResponse)
		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(botEvents()[0]).toEqual([
			'subscribe.bot_allowed',
			expect.objectContaining({ reason: 'botid-error' }),
		])
		expect(JSON.stringify(botEvents())).not.toContain(body.email)
	})

	it('bounds a stalled BotID check and fails open', async () => {
		vi.useFakeTimers()
		try {
			enable('enforce')
			mocks.checkBotId.mockImplementation(() => new Promise(() => {}))
			const response = POST(request(body))
			await vi.advanceTimersByTimeAsync(3000)
			expect((await response).status).toBe(200)
			expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
			expect(botEvents()[0]).toEqual([
				'subscribe.bot_allowed',
				expect.objectContaining({ reason: 'botid-error' }),
			])
		} finally {
			vi.useRealTimers()
		}
	})

	it('off SUCCESS preserves attribution, shortlink and Inngest writes', async () => {
		const payload = { ...body, listId: 9376133 }
		delete mocks.env.DROVR_DOI_FORMS
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.cookieGet.mockImplementation((key: string) =>
			key === 'sl_ref'
				? { value: 'synthetic-source' }
				: key === 'ft_attr'
					? { value: 'synthetic-attribution' }
					: undefined,
		)
		const response = await POST(request(payload))
		expect(await response.json()).toEqual(humanResponse)
		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledTimes(1)
		expect(mocks.recordSignupAttribution).toHaveBeenCalledWith({
			email: body.email,
			formId: 9376133,
			kitSubscriberId: 123,
			rawCookie: 'synthetic-attribution',
		})
		expect(mocks.createShortlinkAttribution).toHaveBeenCalledTimes(1)
		expect(mocks.createShortlinkAttribution).toHaveBeenCalledWith({
			shortlinkSlug: 'synthetic-source',
			email: body.email,
			type: 'signup',
		})
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'skills-newsletter/subscribed',
				data: expect.objectContaining({
					email: body.email,
					formId: 9376133,
					kitSubscriberId: '123',
				}),
			}),
		)
		expect(mocks.checkBotId).not.toHaveBeenCalled()
		expect(botEvents()).toEqual([])
	})

	it('rejection is byte-shaped like the real pending-confirmation route, including normalization and no id', async () => {
		mocks.env.DROVR_DOI_FORMS = '9376133'
		mocks.env.DROVR_API_BASE_URL = 'https://drovr.test'
		mocks.env.DROVR_API_KEY_ORG_AIHERO = 'synthetic-key'
		mocks.resolveDoi.mockResolvedValue({ contactId: 'synthetic-contact' })
		const payload = {
			email: ` ${body.email} `,
			name: ' aBcDeFgHiJ ',
			listId: 9376133,
		}
		try {
			const pending = await POST(request(payload))
			expect(mocks.resolveDoi).toHaveBeenCalledTimes(1)
			vi.clearAllMocks()
			enable('enforce')
			mocks.checkBotId.mockResolvedValue({ isBot: true })
			const rejected = await POST(request(payload))
			expect(rejected.status).toBe(pending.status)
			expect([...rejected.headers]).toEqual([...pending.headers])
			expect(await rejected.text()).toBe(await pending.text())
			expect(mocks.resolveDoi).not.toHaveBeenCalled()
			expect(mocks.courseBuilderPOST).not.toHaveBeenCalled()
		} finally {
			delete mocks.env.DROVR_DOI_FORMS
			delete mocks.env.DROVR_API_BASE_URL
			delete mocks.env.DROVR_API_KEY_ORG_AIHERO
		}
	})

	it('still logs the decision if HMAC fails, without raw input', async () => {
		enable('enforce')
		delete mocks.env.NEXTAUTH_SECRET
		try {
			await POST(request(body))
			expect(botEvents()).toEqual([
				[
					'subscribe.bot_allowed',
					{ mode: 'enforce', reason: 'human', emailHash: undefined },
				],
			])
		} finally {
			mocks.env.NEXTAUTH_SECRET = 'synthetic-test-key'
		}
	})

	it('normalizes the email and scopes the HMAC key', async () => {
		enable('shadow')
		mocks.checkBotId.mockResolvedValue({ isBot: true })
		await POST(request({ ...body, email: ` ${body.email} ` }))
		const scoped = createHmac('sha256', 'synthetic-test-key')
			.update('subscribe-bot-v1')
			.digest()
		expect(botEvents()[0]?.[1].emailHash).toBe(
			createHmac('sha256', scoped)
				.update(body.email.toLowerCase())
				.digest('hex')
				.slice(0, 16),
		)
	})

	it('enforce wins when both switches are on', async () => {
		mocks.redisGet.mockResolvedValue(true)
		mocks.checkBotId.mockResolvedValue({ isBot: true })
		await POST(request(body))
		expect(mocks.courseBuilderPOST).not.toHaveBeenCalled()
		expect(botEvents()[0]?.[0]).toBe('subscribe.bot_rejected')
	})

	it('flag outage fails open to off, without checking BotID', async () => {
		mocks.redisGet.mockRejectedValue(new Error('unavailable'))
		await POST(request(body))
		expect(mocks.checkBotId).not.toHaveBeenCalled()
		expect(mocks.courseBuilderPOST).toHaveBeenCalledTimes(1)
	})
})
