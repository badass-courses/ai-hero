import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readOwnedEvidence: vi.fn(),
	cookieGet: vi.fn(),
	headerGet: vi.fn(),
	getServerAuthSession: vi.fn(),
	getSubscriberFromCookie: vi.fn(),
	inngestSend: vi.fn(),
	issueRecoveryToken: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	reconcile: vi.fn(),
	routeReturning: vi.fn(),
	revalidatePath: vi.fn(),
	setSubscriberCookie: vi.fn(),
	setSubscriberFields: vi.fn(),
	subscribeToList: vi.fn(),
	requestDoi: vi.fn(),
	env: {
		CONVERTKIT_API_SECRET: 'secret',
		CONVERTKIT_API_KEY: 'key',
	} as Record<string, string | undefined>,
}))

vi.mock('@/lib/gated-asks-off-kit', () => ({
	readGatedAskForEmail: mocks.readOwnedEvidence,
}))

vi.mock('next/cache', () => ({
	revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: mocks.cookieGet,
	}),
	headers: async () => ({
		get: mocks.headerGet,
	}),
}))

vi.mock('@/env.mjs', () => ({ env: mocks.env }))

vi.mock('@/lib/subscriber-marketing/drovr-doi-signup.server', () => ({
	requestDrovrDoiSignup: mocks.requestDoi,
}))

vi.mock('@coursebuilder/core/providers/convertkit', () => ({
	setConvertkitSubscriberFields: mocks.setSubscriberFields,
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	setKitSubscriberFields: mocks.setSubscriberFields,
	emailListProvider: {
		subscribeToList: mocks.subscribeToList,
	},
}))

vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
	setSubscriberCookie: mocks.setSubscriberCookie,
}))

// Mocked for reach, not just behaviour: importing the real module pulls
// next-auth in, which cannot resolve `next/server` under vitest.
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

// `server-only` is a build-time guard with no runtime module, so vitest cannot
// resolve it. Stubbed rather than removed from the source: the guard is what
// keeps a session read out of a client bundle.
vi.mock('server-only', () => ({}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		send: mocks.inngestSend,
	},
}))

vi.mock('@/schemas/subscriber', () => ({
	SubscriberSchema: {
		parse: (value: unknown) => value,
	},
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
}))

vi.mock('@/lib/subscriber-marketing/ai-hero-email-opt-in.server', () => ({
	reconcileAiHeroEmailOptInWithKit: mocks.reconcile,
	routeReturningUnsubscriberWithKit: mocks.routeReturning,
}))

vi.mock('@/lib/subscriber-marketing/opt-in-attribution', () => ({
	parseOptInAttributionCookie: () => undefined,
}))

vi.mock(
	'@/lib/subscriber-marketing/skills-course-recovery-token.server',
	() => ({ issueSkillsCourseRecoveryToken: mocks.issueRecoveryToken }),
)

import { tagSubscriberAsSkills } from './skills-newsletter-actions'

describe('tagSubscriberAsSkills', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		delete mocks.env.AIH_ENROLMENT_OFF_KIT_ENABLED
		const subscriber = {
			id: 1,
			email_address: 'contact',
			first_name: null,
			state: 'active',
			fields: {},
		}
		mocks.getSubscriberFromCookie.mockResolvedValue(subscriber)
		mocks.subscribeToList.mockResolvedValue(subscriber)
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.routeReturning
			.mockReset()
			.mockResolvedValue({ status: 'not-unsubscribed' })
		mocks.inngestSend.mockResolvedValue(undefined)
		mocks.issueRecoveryToken.mockResolvedValue(undefined)
		mocks.setSubscriberFields.mockResolvedValue(undefined)
		mocks.cookieGet.mockReturnValue(undefined)
		mocks.headerGet.mockImplementation((name: string) =>
			name === 'x-vercel-ip-timezone' ? 'Europe/London' : null,
		)
		mocks.getServerAuthSession.mockResolvedValue(null)
		process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED = 'true'
		process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED = 'true'
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		delete process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED
		delete process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED
	})

	it('owned signed-in entry works with Kit unreachable and emits only the contact id', async () => {
		mocks.env.AIH_ENROLMENT_OFF_KIT_ENABLED = 'true'
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'new@example.test' } },
		})
		mocks.subscribeToList.mockRejectedValue(new Error('Kit unreachable'))
		mocks.reconcile.mockRejectedValue(new Error('Kit unreachable'))
		mocks.routeReturning.mockRejectedValue(new Error('Kit unreachable'))
		mocks.readOwnedEvidence.mockResolvedValue({
			list: {
				contactId: 'contact-owned',
				state: 'confirmed',
				stops: [],
				forms: [{ formId: 'skills-newsletter', state: 'confirmed' }],
			},
		})
		expect(await tagSubscriberAsSkills('skills-post')).toEqual({
			success: true,
		})
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'skills-newsletter/subscribed',
				data: expect.objectContaining({
					contactId: 'contact-owned',
					email: 'new@example.test',
				}),
			}),
		)
		expect(mocks.inngestSend.mock.calls[0]![0].data).not.toHaveProperty(
			'kitSubscriberId',
		)
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.reconcile).not.toHaveBeenCalled()
		expect(mocks.routeReturning).not.toHaveBeenCalled()
		expect(mocks.setSubscriberCookie).not.toHaveBeenCalled()
		expect(mocks.issueRecoveryToken).not.toHaveBeenCalled()
		expect(mocks.requestDoi).not.toHaveBeenCalled()
	})

	it.each([
		['directory miss', null],
		['unknown', { contactId: 'c1', state: 'unknown', forms: [], stops: [] }],
		[
			'unrelated confirmed form',
			{
				contactId: 'c1',
				state: 'confirmed',
				forms: [{ formId: 'other', state: 'confirmed' }],
				stops: [],
			},
		],
		[
			'unconfirmed skills',
			{
				contactId: 'c1',
				state: 'confirmed',
				forms: [{ formId: 'skills-newsletter', state: 'unconfirmed' }],
				stops: [],
			},
		],
		[
			'unsubscribed',
			{
				contactId: 'c1',
				state: 'stopped',
				forms: [{ formId: 'skills-newsletter', state: 'confirmed' }],
				stops: [{ scope: 'all', reason: 'unsubscribed' }],
			},
		],
	])(
		'owned %s requests DOI only, without a Kit lookup or entry',
		async (_name, list) => {
			mocks.env.AIH_ENROLMENT_OFF_KIT_ENABLED = 'true'
			mocks.getSubscriberFromCookie.mockResolvedValue(null)
			mocks.getServerAuthSession.mockResolvedValue({
				session: { user: { email: 'learner@example.test' } },
			})
			mocks.readOwnedEvidence.mockResolvedValue({ list })
			expect(await tagSubscriberAsSkills('skills-post')).toMatchObject({
				reason: 'confirmation-required',
			})
			expect(mocks.requestDoi).toHaveBeenCalledOnce()
			expect(mocks.inngestSend).not.toHaveBeenCalled()
			expect(mocks.subscribeToList).not.toHaveBeenCalled()
			expect(mocks.routeReturning).not.toHaveBeenCalled()
			expect(mocks.reconcile).not.toHaveBeenCalled()
		},
	)

	it('an owned list-state read failure requests DOI, never the direct-Kit fallback', async () => {
		mocks.env.AIH_ENROLMENT_OFF_KIT_ENABLED = 'true'
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'learner@example.test' } },
		})
		mocks.readOwnedEvidence.mockRejectedValueOnce(
			new Error('list state unavailable'),
		)
		expect(await tagSubscriberAsSkills('skills-post')).toMatchObject({
			reason: 'confirmation-required',
		})
		expect(mocks.requestDoi).toHaveBeenCalledOnce()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.routeReturning).not.toHaveBeenCalled()
	})

	it.each(['false', 'TRUE', 'garbage'])(
		'flag %s retains the existing signed-in Kit path',
		async (flag) => {
			mocks.env.AIH_ENROLMENT_OFF_KIT_ENABLED = flag
			mocks.getSubscriberFromCookie.mockResolvedValue(null)
			mocks.getServerAuthSession.mockResolvedValue({
				session: { user: { email: 'learner@example.test' } },
			})
			mocks.subscribeToList.mockResolvedValue({
				id: 1,
				email_address: 'learner@example.test',
				state: 'active',
				fields: {},
			})
			expect(await tagSubscriberAsSkills('skills-post')).toEqual({
				success: true,
			})
			expect(mocks.subscribeToList).toHaveBeenCalledOnce()
			expect(mocks.readOwnedEvidence).not.toHaveBeenCalled()
		},
	)

	it('owned enqueue failure refuses cleanly and never falls back to Kit', async () => {
		mocks.env.AIH_ENROLMENT_OFF_KIT_ENABLED = 'true'
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'learner@example.test' } },
		})
		mocks.readOwnedEvidence.mockResolvedValue({
			list: {
				contactId: 'c1',
				state: 'confirmed',
				stops: [],
				forms: [{ formId: 'skills-newsletter', state: 'confirmed' }],
			},
		})
		mocks.inngestSend.mockRejectedValueOnce(new Error('queue unavailable'))
		expect(await tagSubscriberAsSkills('skills-post')).toMatchObject({
			reason: 'request-failed',
		})
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
	})

	it('master off skips only the optional field stash, preserving enrolment, consent and the entry fact', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'false')
		const result = await tagSubscriberAsSkills('skills-post')
		expect(result).toEqual({ success: true })
		expect(mocks.setSubscriberFields).not.toHaveBeenCalled()
		expect(mocks.subscribeToList).toHaveBeenCalledOnce()
		expect(mocks.reconcile).toHaveBeenCalledOnce()
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					kitSubscriberId: '1',
					deadlineTimeZone: expect.objectContaining({
						timeZone: 'Europe/London',
					}),
				}),
			}),
		)
	})

	// A signed-in reader is identified without a Kit cookie. Before this they
	// were told "we could not find your subscription — try the form instead",
	// which asked a known person to type an address the server already had.
	it('enrols a signed-in reader with no Kit cookie, using their account email', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'signed-in@example.com', name: 'Vojta' } },
		})

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ email: 'signed-in@example.com' }),
			}),
		)
	})

	// The cookie carries the real Kit record; a session only carries an address.
	// Preferring the session would split a reader who changed their Kit email
	// into two subscribers.
	it('prefers the Kit cookie over the session when both exist', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'signed-in@example.com' } },
		})

		await tagSubscriberAsSkills('skills-post')

		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ email: 'contact' }),
			}),
		)
	})

	it('still reports not-subscribed with neither cookie nor session', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue(null)

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: false, reason: 'not-subscribed' })
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
	})

	it('does not report enrollment failure when recovery token issuance fails', async () => {
		mocks.issueRecoveryToken.mockRejectedValue(
			new Error('token secret missing'),
		)

		await expect(tagSubscriberAsSkills('skills-post')).resolves.toEqual({
			success: true,
		})
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'skills.course.recovery_token_issue_failed',
			{ outcome: 'not-issued' },
		)
	})

	it('stashes browser evidence before returning for Kit confirmation', async () => {
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toMatchObject({
			success: false,
			reason: 'confirmation-required',
		})
		expect(mocks.setSubscriberFields).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					aih_course_entry_evidence: expect.stringContaining('Europe/London'),
				}),
			}),
		)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('exhaustion on, capture unset: no evidence Kit call and no zone', async () => {
		delete process.env.AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })

		await tagSubscriberAsSkills('skills-post')

		expect(mocks.setSubscriberFields).not.toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					aih_course_entry_evidence: expect.anything(),
				}),
			}),
		)
	})

	it('logs a reader signed in as that address whom Kit still holds unconfirmed', async () => {
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })
		mocks.subscribeToList.mockResolvedValue({
			id: 4295840642,
			email_address: 'contact',
			first_name: null,
			state: 'inactive',
			created_at: '2026-09-15T06:32:55Z',
			fields: {},
		})
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'contact' } },
		})

		await tagSubscriberAsSkills('skills-post')

		expect(mocks.log.warn).toHaveBeenCalledWith(
			'kit.subscriber.verified_unconfirmed',
			{
				kitSubscriberId: '4295840642',
				intentKey: 'course:skills',
				via: 'cookie',
				state: 'inactive',
				kitCreatedAt: '2026-09-15T06:32:55Z',
				resubmit: true,
			},
		)
	})

	it('does not log an unconfirmed reader nobody is signed in as', async () => {
		mocks.reconcile.mockResolvedValue({ status: 'confirmation-required' })
		mocks.subscribeToList.mockResolvedValue({
			id: 7,
			email_address: 'contact',
			first_name: null,
			state: 'inactive',
			fields: {},
		})

		await tagSubscriberAsSkills('skills-post')

		expect(mocks.log.warn).not.toHaveBeenCalledWith(
			'kit.subscriber.verified_unconfirmed',
			expect.anything(),
		)
	})

	it('emits course entry with the placement source when ft_attr is absent', async () => {
		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					source: 'aihero_skills_post',
				}),
			}),
		)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					source: 'aihero_skills_post',
					optInAttribution: undefined,
					deadlineTimeZone: {
						type: 'BrowserEntryHeader',
						headerName: 'x-vercel-ip-timezone',
						timeZone: 'Europe/London',
						capturedAt: expect.any(String),
					},
				}),
			}),
		)
		expect(mocks.setSubscriberFields).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					aih_course_entry_evidence: expect.stringContaining('Europe/London'),
				}),
			}),
		)
		expect(mocks.issueRecoveryToken).toHaveBeenCalledWith({
			kitSubscriberId: '1',
			email: 'contact',
		})
		expect(mocks.setSubscriberCookie).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					interest: 'skills',
					source: 'aihero_skills_post',
				}),
			}),
		)
	})
})

describe('tagSubscriberAsSkills with drovr double opt-in (DROVR_DOI_FORMS)', () => {
	const cookieReader = {
		id: 7,
		email_address: 'Reader@Example.com',
		first_name: 'Reader',
		state: 'active',
		fields: {},
	}
	const drovrOn = () => {
		mocks.env.DROVR_DOI_FORMS = '9376133'
		mocks.env.DROVR_API_BASE_URL = 'https://drovr.test'
		mocks.env.DROVR_API_KEY_ORG_AIHERO = 'drovr_key'
	}

	beforeEach(() => {
		vi.clearAllMocks()
		for (const key of [
			'DROVR_DOI_FORMS',
			'DROVR_API_BASE_URL',
			'DROVR_API_KEY_ORG_AIHERO',
		])
			delete mocks.env[key]
		mocks.getSubscriberFromCookie.mockResolvedValue(cookieReader)
		mocks.subscribeToList.mockResolvedValue(cookieReader)
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.routeReturning
			.mockReset()
			.mockResolvedValue({ status: 'not-unsubscribed' })
		mocks.inngestSend.mockResolvedValue(undefined)
		mocks.issueRecoveryToken.mockResolvedValue(undefined)
		mocks.cookieGet.mockReturnValue(undefined)
		mocks.headerGet.mockImplementation((name: string) =>
			name === 'referer' ? 'https://www.aihero.dev/skills' : null,
		)
		mocks.getServerAuthSession.mockResolvedValue(null)
		mocks.requestDoi.mockResolvedValue({ contactId: 'contact-doi-1' })
	})

	it('flag off: a cookie-only reader takes the Kit path, and drovr hears nothing', async () => {
		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.requestDoi).not.toHaveBeenCalled()
	})

	it('flag on, cookie only: confirms by email through drovr, never Kit', async () => {
		drovrOn()
		const result = await tagSubscriberAsSkills('skills-post')

		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.reconcile).not.toHaveBeenCalled()
		expect(mocks.requestDoi).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'Reader@Example.com',
				kitFormId: 9376133,
				page: 'https://www.aihero.dev/skills',
				entry: 'tag-me',
			}),
		)
		expect(result).toEqual({
			success: false,
			reason: 'confirmation-required',
			confirmationUrl: '/confirm?email=Reader%40Example.com',
		})
	})

	it('flag on, signed in as the cookie address: already confirmed, takes the Kit path', async () => {
		drovrOn()
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'reader@example.com' } },
		})
		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.requestDoi).not.toHaveBeenCalled()
	})

	it('flag on, signed in with no cookie: already confirmed, takes the Kit path', async () => {
		drovrOn()
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'signed-in@example.com' } },
		})
		mocks.subscribeToList.mockResolvedValue({
			...cookieReader,
			email_address: 'signed-in@example.com',
		})
		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.requestDoi).not.toHaveBeenCalled()
	})

	it('flag on, signed in as someone else: the cookie address still confirms by email', async () => {
		drovrOn()
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'other@example.com' } },
		})
		const result = await tagSubscriberAsSkills('skills-post')

		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.requestDoi).toHaveBeenCalledTimes(1)
		expect(result).toMatchObject({ reason: 'confirmation-required' })
	})

	it('flag on, drovr path fails: request-failed, never a Kit fallback', async () => {
		drovrOn()
		mocks.requestDoi.mockRejectedValue(new Error('database unavailable'))
		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: false, reason: 'request-failed' })
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('Reader@')
	})
})

describe('tagSubscriberAsSkills for a returning unsubscriber (Kit tag 8244351)', () => {
	const reader = {
		id: 9,
		email_address: 'person@example.com',
		first_name: 'Pat',
		state: 'active',
		fields: {},
	}

	beforeEach(() => {
		vi.clearAllMocks()
		for (const key of [
			'DROVR_DOI_FORMS',
			'DROVR_API_BASE_URL',
			'DROVR_API_KEY_ORG_AIHERO',
		])
			delete mocks.env[key]
		mocks.getSubscriberFromCookie.mockResolvedValue(reader)
		mocks.subscribeToList.mockResolvedValue(reader)
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.inngestSend.mockResolvedValue(undefined)
		mocks.issueRecoveryToken.mockResolvedValue(undefined)
		mocks.cookieGet.mockReturnValue(undefined)
		mocks.headerGet.mockReturnValue(null)
		mocks.getServerAuthSession.mockResolvedValue(null)
		mocks.routeReturning.mockReset()
	})

	it('DOI requested: confirm-by-email answer, no Kit subscribe, no untag', async () => {
		mocks.routeReturning.mockResolvedValue({ status: 'doi-requested' })

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toMatchObject({
			success: false,
			reason: 'confirmation-required',
			confirmationUrl: '/confirm?email=person%40example.com',
		})
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.reconcile).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('drovr state unknown (deferred): success, no Kit subscribe, replays tag-me later', async () => {
		mocks.routeReturning.mockResolvedValue({ status: 'deferred' })

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.reconcile).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
		expect(mocks.routeReturning).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: 'tag-me',
				deferral: expect.objectContaining({
					action: 'tag-me',
					fields: expect.objectContaining({ source: expect.any(String) }),
				}),
			}),
		)
	})

	it('blocked (drovr not configured): request-failed, no Kit subscribe, no untag', async () => {
		mocks.routeReturning.mockResolvedValue({
			status: 'blocked',
			reason: 'drovr-unconfigured',
		})

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: false, reason: 'request-failed' })
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.reconcile).not.toHaveBeenCalled()
	})

	it('Kit lookup failed: enrols through Kit, with the untag disabled', async () => {
		mocks.routeReturning.mockResolvedValue({ status: 'lookup-failed' })

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({ mayRemoveUnsubscribeTag: false }),
		)
	})

	it('not tagged: the Kit path runs unchanged', async () => {
		mocks.routeReturning.mockResolvedValue({ status: 'not-unsubscribed' })

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.reconcile).toHaveBeenCalledTimes(1)
	})
})
