import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	email: 'learner@example.test' as string | null,
	cookies: new Map<string, string>(),
	kit: vi.fn(),
	cookieKit: vi.fn(),
	fetch: vi.fn(),
	doi: vi.fn(),
	send: vi.fn(),
	contactId: 'contact-1' as string | undefined,
	fields: {} as Record<string, string>,
	entries: [] as { occurredAt: Date }[],
	directory: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: m.env }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({ session: { user: { email: m.email } } }),
}))
vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: (key: string) => ({ value: m.cookies.get(key) }),
	}),
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: { getSubscriberByEmail: m.kit },
}))
vi.mock('@/lib/convertkit', () => ({ getSubscriberFromCookie: m.cookieKit }))
vi.mock('@/lib/kit-subscriber-directory', () => ({
	readKitSubscriberIdentity: m.directory,
}))
vi.mock('@/lib/cta/interest-fact-store', () => ({
	findContactIdForEmail: async () => m.contactId,
	readLocalInterestFields: async () => m.fields,
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			contact: {
				findFirst: async () => ({
					email: 'learner@example.test',
					name: 'Learner',
				}),
			},
		},
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => m.entries }) }),
		}),
	},
}))
vi.mock('@/lib/subscriber-marketing/drovr-doi-signup.server', () => ({
	requestDrovrDoiSignup: m.doi,
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: m.send } }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	GATED_ASK_LIST_CACHE_MAX,
	GATED_ASK_LIST_TTL_MS,
	readGatedAskForEmail,
	readGatedAskForEmailFresh,
	resetGatedAskListCache,
} from './gated-asks-off-kit'
import { readOwnedSkillsAdmission } from './subscriber-marketing/owned-skills-list-state'
import { getSubscriberForGating, getCtaGatingPayload } from './subscriber-gate'
import { resolveSkillsCtaState } from './skills-cta-state'
import { hasCompletedConversionIntent } from './cta/conversion-intent'
import {
	reconcileAiHeroEmailOptInWithKit,
	routeReturningUnsubscriberWithKit,
} from './subscriber-marketing/ai-hero-email-opt-in.server'

function reply(
	state: string,
	stops: { reason: string; scope: string; createdAt: string }[] = [],
) {
	return Response.json({
		contactId: 'contact-1',
		kitSubscriberId: '42',
		tenantId: 'org-aihero',
		scope: 'all',
		state,
		forms: [],
		stops,
		unknownReason: state === 'unknown' ? 'no-consent-evidence' : null,
	})
}
const route = () =>
	routeReturningUnsubscriberWithKit({
		email: 'learner@example.test',
		kitFormId: 9376133,
		page: '/skills',
		entry: 'form',
	})

describe('gated asks off Kit (Kit unreachable)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetGatedAskListCache()
		Object.keys(m.env).forEach((key) => delete m.env[key])
		Object.assign(m.env, {
			AIH_GATED_ASKS_OFF_KIT_ENABLED: 'true',
			DROVR_API_BASE_URL: 'https://drovr.example.test',
			DROVR_API_KEY_ORG_AIHERO: 'synthetic-key',
		})
		m.email = 'learner@example.test'
		m.contactId = 'contact-1'
		m.cookies.clear()
		m.entries = []
		m.fields = {}
		m.kit.mockRejectedValue(new Error('Kit unreachable'))
		m.cookieKit.mockRejectedValue(new Error('Kit unreachable'))
		m.fetch.mockImplementation(async () => reply('confirmed'))
		m.directory.mockResolvedValue({
			id: 42,
			email_address: 'learner@example.test',
		})
		vi.stubGlobal('fetch', m.fetch)
	})
	afterEach(() => {
		expect(m.kit).not.toHaveBeenCalled()
		expect(m.cookieKit).not.toHaveBeenCalled()
		vi.unstubAllGlobals()
	})

	it.each([
		['confirmed', true, 'tag-me', 'active'],
		['unconfirmed', false, 'account', 'confirmation-required'],
		['stopped', false, 'account', 'confirmation-required'],
		['unknown', false, 'account', 'confirmation-required'],
	] as const)(
		'%s controls newsletter, skills and opt-in reconciliation',
		async (state, complete, skills, optIn) => {
			m.fetch.mockImplementation(async () => reply(state))
			// Stale positive cookies must not hide an ask.
			m.cookies.set(
				'ck_subscriber',
				JSON.stringify({
					id: 42,
					state: 'active',
					fields: { aih_course_started_at: '2026-10-01' },
				}),
			)
			const subscriber = await getSubscriberForGating()
			expect(
				hasCompletedConversionIntent({ kind: 'newsletter' }, subscriber),
			).toBe(complete)
			expect(await resolveSkillsCtaState(m.email)).toBe(skills)
			expect(
				(
					await reconcileAiHeroEmailOptInWithKit({
						email: m.email!,
						subscriberState: 'active',
					})
				).status,
			).toBe(optIn)
			const [url, options] = m.fetch.mock.calls[0]!
			expect(url).toBe(
				'https://drovr.example.test/contact-list-state?contactId=contact-1',
			)
			expect(options).toMatchObject({
				method: 'GET',
				headers: { authorization: 'Bearer synthetic-key' },
			})
			expect(options.body).toBeUndefined()
		},
	)

	it('local value-path.entered hides the skills ask, without a Kit field', async () => {
		m.entries = [{ occurredAt: new Date('2026-10-01T00:00:00Z') }]
		expect(await resolveSkillsCtaState(m.email)).toBe('subscribed')
		expect(
			hasCompletedConversionIntent(
				{ kind: 'skills-course' },
				await getSubscriberForGating(),
			),
		).toBe(true)
	})

	it('local waitlist/interest facts replace Kit fields, independent of the old interest flag', async () => {
		m.fields = {
			waitlist_cohort_four: '2026-10-01',
			interest_workshop: '2026-10-01',
		}
		const subscriber = await getSubscriberForGating()
		expect(
			hasCompletedConversionIntent(
				{ kind: 'cohort-waitlist', productName: 'Cohort Four' },
				subscriber,
			),
		).toBe(true)
		expect((await getCtaGatingPayload())?.fields).toEqual(m.fields)
	})

	it('a drovr outage is unknown, not subscribed, and never a Kit fallback', async () => {
		m.fetch.mockRejectedValue(new Error('drovr unreachable'))
		expect(
			hasCompletedConversionIntent(
				{ kind: 'newsletter' },
				await getSubscriberForGating(),
			),
		).toBe(false)
		expect(await resolveSkillsCtaState(m.email)).toBe('account')
		expect(await route()).toEqual({ status: 'doi-requested' })
		expect(m.doi).toHaveBeenCalledTimes(1)
	})

	it('confirmed and unconfirmed submissions do not look up Kit', async () => {
		expect(await route()).toEqual({ status: 'not-unsubscribed' })
		m.fetch.mockImplementation(async () => reply('unconfirmed'))
		expect(await route()).toEqual({ status: 'not-unsubscribed' })
	})

	it('a stopped unsubscribe requires DOI; bounce/complaint cannot resubscribe', async () => {
		m.fetch.mockImplementation(async () =>
			reply('stopped', [
				{ reason: 'unsubscribed', scope: 'all', createdAt: '2026-10-01' },
			]),
		)
		expect(await route()).toEqual({ status: 'doi-requested' })
		expect(m.doi).toHaveBeenCalledTimes(1)
		m.fetch.mockImplementation(async () =>
			reply('stopped', [
				{ reason: 'complained', scope: 'all', createdAt: '2026-10-01' },
			]),
		)
		expect(await route()).toEqual({ status: 'blocked', reason: 'suppressed' })
		expect(m.doi).toHaveBeenCalledTimes(1)
	})

	it('signed-out id-only reader resolves locally; public payload does not expose a cookie oracle', async () => {
		m.email = null
		m.cookies.set('ck_subscriber_id', '42')
		expect((await getSubscriberForGating())?.state).toBe('active')
		expect(m.directory).toHaveBeenCalledWith('42')
		m.fetch.mockClear()
		expect(await getCtaGatingPayload()).toBeNull()
		expect(m.fetch).not.toHaveBeenCalled()
	})

	it('a missing local contact is unknown and never falls back to Kit', async () => {
		m.contactId = undefined
		expect(
			hasCompletedConversionIntent(
				{ kind: 'newsletter' },
				await getSubscriberForGating(),
			),
		).toBe(false)
		expect(await resolveSkillsCtaState(m.email)).toBe('account')
		expect(m.fetch).not.toHaveBeenCalled()
	})

	it('course entry remains known when the list read fails', async () => {
		m.entries = [{ occurredAt: new Date('2026-10-01T00:00:00Z') }]
		m.fetch.mockRejectedValue(new Error('drovr unavailable'))
		expect(await resolveSkillsCtaState(m.email)).toBe('subscribed')
		expect(
			hasCompletedConversionIntent(
				{ kind: 'newsletter' },
				await getSubscriberForGating(),
			),
		).toBe(false)
	})

	it('defaults off and preserves the existing cookie-only gate', async () => {
		delete m.env.AIH_GATED_ASKS_OFF_KIT_ENABLED
		m.cookies.set(
			'ck_subscriber',
			JSON.stringify({ id: 42, state: 'active', fields: {} }),
		)
		expect((await getSubscriberForGating())?.state).toBe('active')
		expect(m.fetch).not.toHaveBeenCalled()
	})

	it('a contact without a Kit alias can still be confirmed in drovr', async () => {
		m.fetch.mockImplementation(async () => {
			const body = await reply('confirmed').json()
			body.kitSubscriberId = null
			return Response.json(body)
		})
		expect((await getSubscriberForGating())?.state).toBe('active')
	})
})

describe('gated ask list-state cache', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		resetGatedAskListCache()
		Object.keys(m.env).forEach((key) => delete m.env[key])
		Object.assign(m.env, {
			AIH_GATED_ASKS_OFF_KIT_ENABLED: 'true',
			DROVR_API_BASE_URL: 'https://drovr.example.test',
			DROVR_API_KEY_ORG_AIHERO: 'synthetic-key',
		})
		m.contactId = 'contact-1'
		m.entries = []
		m.fields = {}
		m.fetch.mockImplementation(async () => reply('confirmed'))
		vi.stubGlobal('fetch', m.fetch)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('two reads for the same contact within 60s make one drovr call', async () => {
		await readGatedAskForEmail('a@example.test')
		await vi.advanceTimersByTimeAsync(GATED_ASK_LIST_TTL_MS - 1)
		const second = await readGatedAskForEmail('b@example.test')
		expect(m.fetch).toHaveBeenCalledTimes(1)
		expect(second.list?.state).toBe('confirmed')
	})

	it('calls drovr again once 60s has passed', async () => {
		await readGatedAskForEmail('a@example.test')
		await vi.advanceTimersByTimeAsync(GATED_ASK_LIST_TTL_MS + 1)
		await readGatedAskForEmail('b@example.test')
		expect(m.fetch).toHaveBeenCalledTimes(2)
	})

	it('never caches an unavailable answer', async () => {
		m.fetch.mockResolvedValueOnce(new Response('', { status: 503 }))
		expect((await readGatedAskForEmail('a@example.test')).list).toBeNull()
		expect((await readGatedAskForEmail('b@example.test')).list?.state).toBe(
			'confirmed',
		)
		expect(m.fetch).toHaveBeenCalledTimes(2)
	})

	it('caches stopped and no-consent-evidence, not unconfirmed or no-contact', async () => {
		for (const [state, cached] of [
			['stopped', true],
			['unknown', true],
			['unconfirmed', false],
		] as const) {
			resetGatedAskListCache()
			m.fetch.mockClear()
			m.fetch.mockImplementation(async () => reply(state))
			await readGatedAskForEmail('a@example.test')
			await readGatedAskForEmail('b@example.test')
			expect(m.fetch).toHaveBeenCalledTimes(cached ? 1 : 2)
		}
		resetGatedAskListCache()
		m.fetch.mockClear()
		m.fetch.mockImplementation(async () => {
			const body = await reply('unknown').json()
			body.unknownReason = 'no-contact'
			return Response.json(body)
		})
		await readGatedAskForEmail('a@example.test')
		await readGatedAskForEmail('b@example.test')
		expect(m.fetch).toHaveBeenCalledTimes(2)
	})

	it('caps the cache and evicts the oldest entry', async () => {
		m.fetch.mockImplementation(async (url: string) => {
			const body = await reply('confirmed').json()
			body.contactId = new URL(url).searchParams.get('contactId')
			return Response.json(body)
		})
		for (let i = 0; i <= GATED_ASK_LIST_CACHE_MAX; i++) {
			m.contactId = `c-${i}`
			await readGatedAskForEmail(`u${i}@example.test`)
		}
		m.fetch.mockClear()
		m.contactId = `c-${GATED_ASK_LIST_CACHE_MAX}`
		await readGatedAskForEmailFresh('x@example.test')
		expect(m.fetch).toHaveBeenCalledTimes(1) // fresh never hits the cache
		m.fetch.mockClear()
		await readGatedAskForEmail('y@example.test')
		expect(m.fetch).not.toHaveBeenCalled() // newest still cached
		m.contactId = 'c-0'
		await readGatedAskForEmail('z@example.test')
		expect(m.fetch).toHaveBeenCalledTimes(1) // oldest evicted
	})

	it('the fresh read and the owned enrolment admission never use the cache', async () => {
		await readGatedAskForEmail('a@example.test') // primes the cache
		m.fetch.mockClear()
		await readGatedAskForEmailFresh('a@example.test')
		expect(m.fetch).toHaveBeenCalledTimes(1)
		const fetchSpy = vi.fn(async () => reply('confirmed'))
		const config = {
			baseUrl: 'https://drovr.example.test',
			apiKey: 'synthetic-key',
			fetch: fetchSpy as unknown as typeof fetch,
		}
		await readOwnedSkillsAdmission('contact-1', config)
		await readOwnedSkillsAdmission('contact-1', config)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it('reconcile and returning-unsubscriber decisions call drovr despite a cached entry', async () => {
		await readGatedAskForEmail('a@example.test') // caches contact-1
		m.fetch.mockClear()
		await reconcileAiHeroEmailOptInWithKit({ email: 'a@example.test' })
		expect(m.fetch).toHaveBeenCalledTimes(1)
		m.fetch.mockClear()
		await route()
		expect(m.fetch).toHaveBeenCalledTimes(1)
	})
})
