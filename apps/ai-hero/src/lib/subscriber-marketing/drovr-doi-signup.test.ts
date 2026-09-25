import { describe, expect, it, vi } from 'vitest'

import { contactEmailWriteValues } from './contact-email-equivalence'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import {
	buildDrovrSignupRequest,
	DoiSignupContactAmbiguousError,
	DOI_REQUESTED_EVENT_TYPE,
	doiAppliesTo,
	DrovrSignupRefusedError,
	DrovrSignupRetryableError,
	parseDrovrDoiConfig,
	parseDrovrSignupDeliveryConfig,
	postDrovrSignup,
	resolveDoiSignupContact,
} from './drovr-doi-signup'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'

const reachable = {
	DROVR_API_BASE_URL: 'https://drovr.test',
	DROVR_API_KEY_ORG_AIHERO: 'drovr_key',
}
const now = '2026-09-25T07:00:00.000Z'

describe('DROVR_DOI_FORMS (the kill switch)', () => {
	it('is off when unset, empty, junk, an unknown form, or drovr is not configured', () => {
		expect(parseDrovrDoiConfig(reachable)).toBeUndefined()
		expect(
			parseDrovrDoiConfig({ ...reachable, DROVR_DOI_FORMS: '' }),
		).toBeUndefined()
		expect(
			parseDrovrDoiConfig({ ...reachable, DROVR_DOI_FORMS: 'yes' }),
		).toBeUndefined()
		expect(
			parseDrovrDoiConfig({ ...reachable, DROVR_DOI_FORMS: '1234' }),
		).toBeUndefined()
		expect(parseDrovrDoiConfig({ DROVR_DOI_FORMS: '9376133' })).toBeUndefined()
		expect(
			parseDrovrDoiConfig({
				DROVR_DOI_FORMS: '9376133',
				DROVR_API_BASE_URL: 'https://drovr.test',
			}),
		).toBeUndefined()
		expect(doiAppliesTo(undefined, 9376133, 'a@example.com')).toBe(false)
	})

	it('turns the Skills form on for an address allowlist, case-insensitively', () => {
		const config = parseDrovrDoiConfig({
			...reachable,
			DROVR_DOI_FORMS: '9376133:Canary@Example.com|other@example.com',
		})
		expect(doiAppliesTo(config, 9376133, ' canary@example.COM ')).toBe(true)
		expect(doiAppliesTo(config, 9376133, 'someone@example.com')).toBe(false)
		expect(doiAppliesTo(config, 1234, 'canary@example.com')).toBe(false)
	})

	it('turns the Skills form on for everyone, and derives the base URL from the ingest URL', () => {
		const config = parseDrovrDoiConfig({
			DROVR_DOI_FORMS: '9376133',
			DROVR_SHADOW_INGEST_URL: 'https://api.drovr.test/events',
			DROVR_API_KEY_ORG_AIHERO: 'drovr_key',
		})
		expect(config?.baseUrl).toBe('https://api.drovr.test')
		expect(doiAppliesTo(config, 9376133, 'anyone@example.com')).toBe(true)
	})
})

describe('delivery config (independent of the intake flag)', () => {
	it('delivers a queued signup after DROVR_DOI_FORMS is turned off', () => {
		expect(parseDrovrDoiConfig(reachable)).toBeUndefined()
		expect(parseDrovrSignupDeliveryConfig(reachable)).toEqual({
			baseUrl: 'https://drovr.test',
			apiKey: 'drovr_key',
		})
		expect(
			parseDrovrSignupDeliveryConfig({
				DROVR_API_BASE_URL: 'https://drovr.test',
			}),
		).toBeUndefined()
	})
})

describe('resolveDoiSignupContact', () => {
	const setup = () => new InMemorySubscriberMarketingRepository()

	it('creates the contact with an ai-hero identity and a doi-requested event that drovr maps to nothing', async () => {
		const repository = setup()
		const { contactId } = await resolveDoiSignupContact({
			repository: repository as never,
			findContactIdsByEmailKey: async () => [],
			email: 'Learner@Example.com',
			name: 'Ada',
			drovrFormId: 'skills-newsletter',
			now,
		})

		expect(repository.contacts.get(contactId)?.email).toBe(
			'learner@example.com',
		)
		const events = Array.from(repository.contactEvents.values())
		expect(events.map((event) => event.eventType)).toEqual([
			DOI_REQUESTED_EVENT_TYPE,
		])
		expect(events[0]?.provider).toBe('ai-hero')
		// No value-path birth before confirmation.
		expect(
			mapDrovrShadowFact({ kind: 'contact-event', event: events[0]! }),
		).toEqual([])
		expect(
			Array.from(repository.providerIdentities.values()).map(
				(identity) => identity.provider,
			),
		).toEqual(['ai-hero'])
	})

	it('reuses the contact that already has this address, never a duplicate', async () => {
		const repository = setup()
		const existing = await repository.createContact({
			...contactEmailWriteValues('learner@example.com'),
			userId: null,
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: now,
			updatedAt: now,
		} as never)
		const findContactIdsByEmailKey = vi.fn(async () => [existing.id])

		const first = await resolveDoiSignupContact({
			repository: repository as never,
			findContactIdsByEmailKey,
			email: ' LEARNER@example.com',
			drovrFormId: 'skills-newsletter',
			now,
		})
		const again = await resolveDoiSignupContact({
			repository: repository as never,
			findContactIdsByEmailKey,
			email: 'learner@example.com',
			drovrFormId: 'skills-newsletter',
			now,
		})

		expect(first.contactId).toBe(existing.id)
		expect(again.contactId).toBe(existing.id)
		expect(repository.contacts.size).toBe(1)
		// The identity links on the first signup; the repeat finds it directly.
		expect(findContactIdsByEmailKey).toHaveBeenCalledTimes(1)
		expect(repository.contactEvents.size).toBe(1)
	})

	it('refuses an address two contacts share', async () => {
		await expect(
			resolveDoiSignupContact({
				repository: setup() as never,
				findContactIdsByEmailKey: async () => ['contact-a', 'contact-b'],
				email: 'learner@example.com',
				drovrFormId: 'skills-newsletter',
				now,
			}),
		).rejects.toBeInstanceOf(DoiSignupContactAmbiguousError)
	})
})

describe('postDrovrSignup (POST /signups)', () => {
	const request = buildDrovrSignupRequest({
		contactId: 'contact-1',
		drovrFormId: 'skills-newsletter',
		occurredAt: now,
		submissionId: 'submission-1',
		page: 'https://www.aihero.dev/skills',
	})
	const config = (status: number, body?: unknown) => {
		const fetcher = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(body === undefined ? null : JSON.stringify(body), {
					status,
				}),
		)
		return {
			fetcher,
			config: {
				baseUrl: 'https://drovr.test',
				apiKey: 'drovr_key',
				fetch: fetcher,
			},
		}
	}

	it('posts the contract body with the tenant key and answers drovr status', async () => {
		const { fetcher, config: c } = config(200, {
			status: 'awaiting-confirmation',
		})
		await expect(postDrovrSignup(request, c)).resolves.toBe(
			'awaiting-confirmation',
		)
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			'https://drovr.test/signups',
		)
		const init = fetcher.mock.calls[0]?.[1]
		expect(init?.method).toBe('POST')
		expect((init?.headers as Record<string, string>).authorization).toBe(
			'Bearer drovr_key',
		)
		expect(JSON.parse(String(init?.body))).toEqual({
			tenantId: 'org-aihero',
			contactId: 'contact-1',
			formId: 'skills-newsletter',
			occurredAt: now,
			submissionId: 'submission-1',
			source: { page: 'https://www.aihero.dev/skills' },
		})
		for (const status of ['already-confirmed', 'suppressed'] as const) {
			await expect(
				postDrovrSignup(request, config(200, { status }).config),
			).resolves.toBe(status)
		}
	})

	it('throws retryable on 408, 429, 5xx, an unreadable reply or no network', async () => {
		for (const status of [408, 429, 500, 503]) {
			await expect(
				postDrovrSignup(request, config(status, {}).config),
			).rejects.toBeInstanceOf(DrovrSignupRetryableError)
		}
		await expect(
			postDrovrSignup(request, config(200, { status: 'maybe' }).config),
		).rejects.toBeInstanceOf(DrovrSignupRetryableError)
		await expect(
			postDrovrSignup(request, {
				baseUrl: 'https://drovr.test',
				apiKey: 'k',
				fetch: async () => {
					throw new TypeError('fetch failed')
				},
			}),
		).rejects.toBeInstanceOf(DrovrSignupRetryableError)
	})

	it('times out a 200 whose body stalls, as retryable', async () => {
		const stalled = postDrovrSignup(request, {
			baseUrl: 'https://drovr.test',
			apiKey: 'k',
			timeoutMs: 20,
			fetch: async () =>
				({
					status: 200,
					json: () => new Promise(() => undefined),
				}) as unknown as Response,
		})
		await expect(stalled).rejects.toBeInstanceOf(DrovrSignupRetryableError)
		await expect(stalled).rejects.toThrow(/timed out/)
	})

	it('times out a request with no headers at all, as retryable', async () => {
		await expect(
			postDrovrSignup(request, {
				baseUrl: 'https://drovr.test',
				apiKey: 'k',
				timeoutMs: 20,
				fetch: () => new Promise<Response>(() => undefined),
			}),
		).rejects.toThrow(/timed out/)
	})

	it('throws refused, naming drovr problem type, on another 4xx', async () => {
		const refused = postDrovrSignup(
			request,
			config(422, { type: 'urn:drovr:problem:unknown-form' }).config,
		)
		await expect(refused).rejects.toBeInstanceOf(DrovrSignupRefusedError)
		await expect(refused).rejects.toMatchObject({ httpStatus: 422 })
	})
})
