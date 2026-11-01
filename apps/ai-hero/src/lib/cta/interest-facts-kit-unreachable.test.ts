import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Card 6 behavior: join, already-joined and anonymous with Kit unreachable.
 * Every Kit call here rejects the way a down api.kit.com does. The anonymous
 * form path lives in the subscribe route's own tests.
 */
const kitDown = () => Promise.reject(new TypeError('fetch failed'))

const mocks = vi.hoisted(() => ({
	cookies: new Map<string, string>(),
	session: null as null | { session: { user: { email: string } } },
	inngestSend: vi.fn(),
	setSubscriberCookie: vi.fn(),
	resolveEnrolmentIdentity: vi.fn(),
	findContactIdForEmail: vi.fn(),
	readLocalInterestFields: vi.fn(),
	kit: {
		subscribeToList: vi.fn(),
		tagSubscriber: vi.fn(),
		getSubscriberByEmail: vi.fn(),
	},
	getSubscriberFromCookie: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = mocks.cookies.get(name)
			return value === undefined ? undefined : { value }
		},
	}),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => mocks.session,
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: mocks.kit,
}))
vi.mock('@/env.mjs', () => ({ env: { CONVERTKIT_SIGNUP_FORM: 123 } }))
vi.mock('@/lib/convertkit', () => ({
	setSubscriberCookie: mocks.setSubscriberCookie,
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))
vi.mock('@/lib/enrolment-identity', () => ({
	resolveEnrolmentIdentity: mocks.resolveEnrolmentIdentity,
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/cta/interest-fact-store', () => ({
	findContactIdForEmail: mocks.findContactIdForEmail,
	readLocalInterestFields: mocks.readLocalInterestFields,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { addWorkshopInterest } from '@/app/(content)/workshops/_components/workshop-interest-actions'
import { hasWorkshopInterest, isOnCohortWaitlist } from '@/lib/cta-gating'
import {
	getCtaGatingPayload,
	getSubscriberForGating,
} from '@/lib/subscriber-gate'

import {
	completeKnownConversionIntent,
	finalizeAnonymousConversionIntent,
} from './conversion-intent-actions'

const factEvents = () =>
	mocks.inngestSend.mock.calls
		.flatMap(([events]) => (Array.isArray(events) ? events : [events]))
		.filter((event) => event?.name === 'aihero/interest.fact.requested')

beforeEach(() => {
	vi.clearAllMocks()
	mocks.cookies.clear()
	mocks.session = null
	mocks.inngestSend.mockResolvedValue(undefined)
	mocks.kit.subscribeToList.mockImplementation(kitDown)
	mocks.kit.tagSubscriber.mockImplementation(kitDown)
	mocks.kit.getSubscriberByEmail.mockImplementation(kitDown)
	mocks.getSubscriberFromCookie.mockImplementation(kitDown)
	mocks.resolveEnrolmentIdentity.mockResolvedValue({
		identity: { email: 'reader@example.test', via: 'session' },
		subscriber: null,
	})
	vi.stubEnv('AIH_INTEREST_FACTS_ENABLED', 'true')
	vi.stubEnv('AIH_INTEREST_FACTS_GATING', 'true')
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('join, Kit unreachable', () => {
	it('master off overrides the interest mirror flag without changing drovr join facts', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'false')
		vi.stubEnv('AIH_INTEREST_KIT_WRITES', 'on')
		const result = await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})
		expect(result).toEqual({ success: true, confirmationRequired: false })
		expect(factEvents()).toHaveLength(1)
		expect(mocks.kit.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.kit.tagSubscriber).not.toHaveBeenCalled()
	})

	it('master off never falls back to Kit when the owned facts are disabled', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'false')
		vi.stubEnv('AIH_INTEREST_FACTS_ENABLED', 'false')
		const result = await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})
		expect(result).toEqual({ success: false, reason: 'request-failed' })
		expect(mocks.kit.subscribeToList).not.toHaveBeenCalled()
	})
	it('cohort waitlist one-click after the cut: joined, from the fact alone', async () => {
		vi.stubEnv('AIH_INTEREST_KIT_WRITES', 'off')
		const result = await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})

		expect(result).toEqual({ success: true, confirmationRequired: false })
		expect(mocks.kit.subscribeToList).not.toHaveBeenCalled()
		expect(mocks.kit.tagSubscriber).not.toHaveBeenCalled()
		expect(factEvents()).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					email: 'reader@example.test',
					fieldKey: 'waitlist_ai_coding_crash_course',
					via: 'one-click',
				}),
			}),
		])
	})

	it('cookie reader after the cut: the gate cookie carries the join at once', async () => {
		vi.stubEnv('AIH_INTEREST_KIT_WRITES', 'off')
		mocks.resolveEnrolmentIdentity.mockResolvedValue({
			identity: { email: 'reader@example.test', via: 'cookie' },
			subscriber: { id: 42, state: 'active', fields: {} },
		})
		await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})

		expect(mocks.setSubscriberCookie).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 42,
				fields: expect.objectContaining({
					waitlist_ai_coding_crash_course: expect.any(String),
				}),
			}),
		)
	})

	it('before the cut: the fact is queued even though the Kit write fails', async () => {
		const result = await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})

		expect(result).toEqual({ success: false, reason: 'request-failed' })
		expect(factEvents()).toHaveLength(1)
	})

	it('workshop interest one-click after the cut: no Kit worker, the answer carries the join', async () => {
		vi.stubEnv('AIH_INTEREST_KIT_WRITES', 'off')
		const result = await addWorkshopInterest('claude-code', 'workshop-page')

		expect(result).toMatchObject({
			success: true,
			gate: { fields: { interest_claude_code: expect.any(String) } },
		})
		expect(
			mocks.inngestSend.mock.calls
				.flatMap(([events]) => (Array.isArray(events) ? events : [events]))
				.map((event) => event?.name),
		).toEqual(['aihero/interest.fact.requested'])
	})

	it('the cut never drops a join: with the facts off, Kit is still asked', async () => {
		vi.stubEnv('AIH_INTEREST_FACTS_ENABLED', '')
		vi.stubEnv('AIH_INTEREST_KIT_WRITES', 'off')
		await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})
		expect(mocks.kit.subscribeToList).toHaveBeenCalledTimes(1)
		expect(factEvents()).toEqual([])
	})
})

describe('a failed fact queue after the cut keeps the Kit write', () => {
	const intent = {
		kind: 'cohort-waitlist',
		productName: 'AI Coding Crash Course',
	} as const

	beforeEach(() => {
		vi.stubEnv('AIH_INTEREST_KIT_WRITES', 'off')
		mocks.kit.subscribeToList.mockResolvedValue({
			id: 42,
			state: 'active',
			fields: {},
		})
		mocks.kit.tagSubscriber.mockResolvedValue(undefined)
	})

	it('one-click: the join lands in Kit, field and tag, when Inngest refuses', async () => {
		mocks.inngestSend.mockRejectedValue(new Error('inngest down'))
		const result = await completeKnownConversionIntent({
			intent,
			surface: 'cohort-page',
		})

		expect(result).toEqual({ success: true, confirmationRequired: false })
		expect(mocks.kit.subscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.kit.tagSubscriber).toHaveBeenCalledWith({
			tag: 'waitlist_ai_coding_crash_course',
			email: 'reader@example.test',
		})
	})

	it('form finalize: a failed queue still tags in Kit', async () => {
		mocks.inngestSend.mockRejectedValue(new Error('inngest down'))
		await finalizeAnonymousConversionIntent({
			intent,
			surface: 'cohort-page',
			email: 'reader@example.test',
		})
		expect(mocks.kit.tagSubscriber).toHaveBeenCalledTimes(1)
	})

	it('form finalize: a queued fact holds the join, so no Kit tag', async () => {
		await finalizeAnonymousConversionIntent({
			intent,
			surface: 'cohort-page',
			email: 'reader@example.test',
		})
		expect(mocks.kit.tagSubscriber).not.toHaveBeenCalled()
		expect(factEvents()).toHaveLength(1)
	})
})

describe('already joined, Kit unreachable', () => {
	beforeEach(() => {
		mocks.session = { session: { user: { email: 'reader@example.test' } } }
		mocks.findContactIdForEmail.mockResolvedValue('local-1')
		mocks.readLocalInterestFields.mockResolvedValue({
			waitlist_ai_coding_crash_course: '2026-10-20',
			interest_claude_code: '2026-10-21',
		})
	})

	it('server render: the signed-in reader is already on the waitlist, from local facts', async () => {
		const subscriber = await getSubscriberForGating()

		expect(isOnCohortWaitlist(subscriber, 'AI Coding Crash Course')).toBe(true)
		expect(hasWorkshopInterest(subscriber, 'claude-code')).toBe(true)
		expect(isOnCohortWaitlist(subscriber, 'Another Cohort')).toBe(false)
		// No list answer is invented from a join.
		expect(subscriber?.state).toBeUndefined()
	})

	it('client gate payload: the same answer, with no identity value on the wire', async () => {
		const payload = await getCtaGatingPayload()

		expect(isOnCohortWaitlist(payload, 'AI Coding Crash Course')).toBe(true)
		expect(JSON.stringify(payload)).not.toContain('reader@example.test')
	})

	it('a forged cookie address is never looked up: facts come from the session only', async () => {
		mocks.session = null
		mocks.cookies.set(
			'ck_subscriber_gate',
			JSON.stringify({
				id: 7,
				email_address: 'someone-else@example.test',
				state: 'active',
				fields: {},
			}),
		)
		const payload = await getCtaGatingPayload()

		expect(mocks.findContactIdForEmail).not.toHaveBeenCalled()
		expect(isOnCohortWaitlist(payload, 'AI Coding Crash Course')).toBe(false)
	})

	it('gating switch off: local facts are not read', async () => {
		vi.stubEnv('AIH_INTEREST_FACTS_GATING', '')
		await getCtaGatingPayload()
		expect(mocks.findContactIdForEmail).not.toHaveBeenCalled()
	})
})

describe('anonymous, Kit unreachable', () => {
	it('no identity: the gate shows the ask and reads no facts', async () => {
		const subscriber = await getSubscriberForGating()

		expect(subscriber).toBeNull()
		expect(isOnCohortWaitlist(subscriber, 'AI Coding Crash Course')).toBe(false)
		expect(mocks.findContactIdForEmail).not.toHaveBeenCalled()
	})

	it('no identity: one-click refuses and records nothing, so the form asks for an address', async () => {
		mocks.resolveEnrolmentIdentity.mockResolvedValue({
			identity: null,
			subscriber: null,
		})
		const result = await completeKnownConversionIntent({
			intent: {
				kind: 'cohort-waitlist',
				productName: 'AI Coding Crash Course',
			},
			surface: 'cohort-page',
		})

		expect(result).toEqual({ success: false, reason: 'not-identified' })
		expect(factEvents()).toEqual([])
	})
})
