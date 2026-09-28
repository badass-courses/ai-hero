import { describe, expect, it, vi } from 'vitest'

import { KitV4Error } from './drovr-evergreen'
import {
	acceptDrovrIntent,
	type DrovrExecutorRepository,
	type DrovrIntent,
} from './drovr-executor'
import {
	createKitFormSubscriber,
	createResubscribeRecorder,
	DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE,
	resubscribeProviderEventId,
	KIT_SUBSCRIBE_RETRY_MS,
	linkKitSubscriberIdentity,
	type KitFormSubscriber,
} from './drovr-list-subscribe'
import type {
	ContactEventRecord,
	ContactRecord,
	SideEffectIntent,
} from './types'

const now = '2026-09-25T06:30:00.000Z'

class FakeRepository implements DrovrExecutorRepository {
	contacts = new Map<string, ContactRecord>()
	intents = new Map<string, SideEffectIntent>()

	findContactById(id: string) {
		return this.contacts.get(id)
	}
	findSideEffectIntentByIdempotencyKey(idempotencyKey: string) {
		return Array.from(this.intents.values()).find(
			(intent) => intent.idempotencyKey === idempotencyKey,
		)
	}
	createSideEffectIntent(input: SideEffectIntent) {
		if (this.findSideEffectIntentByIdempotencyKey(input.idempotencyKey)) {
			throw new Error('Duplicate entry')
		}
		this.intents.set(input.id, input)
		return input
	}
	findValuePathEmailSideEffectIntentsByContact() {
		return []
	}
	claimSideEffectIntentForSend(
		id: string,
		args: { now: string; staleAfterMs: number },
	) {
		const row = this.intents.get(id)
		if (!row || (row.status !== 'pending' && row.status !== 'failed'))
			return false
		this.intents.set(id, {
			...row,
			status: 'sending',
			metadata: { ...row.metadata, claimedAt: args.now },
		})
		return true
	}
	finishClaimedSideEffectIntent(
		id: string,
		claimedAt: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata' | 'completedAt'
		>,
	) {
		const row = this.intents.get(id)
		if (row?.status !== 'sending' || row.metadata.claimedAt !== claimedAt)
			return undefined
		const next = { ...row, ...patch }
		this.intents.set(id, next)
		return next
	}
}

const contact: ContactRecord = {
	id: 'contact-1',
	email: 'learner@example.com',
	name: 'Ada Learner',
	lifecycle: 'new',
	isProvisional: true,
	createdAt: now,
	updatedAt: now,
}

const confirmation = (overrides: Partial<DrovrIntent> = {}): DrovrIntent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'double-opt-in',
	kind: 'list.subscribe',
	idempotencyKey: 'doi:org-aihero:contact-1:skills-newsletter:kit',
	dueAt: now,
	payload: {
		confirmedAt: now,
		formId: 'skills-newsletter',
		kitFormId: 9376133,
		reason: 'double-opt-in-confirmed',
	},
	...overrides,
})

const kit = (
	impl: KitFormSubscriber = async () => ({
		kitSubscriberId: '4310000001',
		state: 'active',
		unsubscribeTagRemoved: false,
	}),
) => vi.fn<Parameters<KitFormSubscriber>, ReturnType<KitFormSubscriber>>(impl)

/** The executor with a lift recorder that finds nothing to lift, unless given one. */
const accept = (args: Parameters<typeof acceptDrovrIntent>[0]) =>
	acceptDrovrIntent({
		recordResubscribe: async () => 'not-unsubscribed',
		...args,
	})

function setup() {
	const repository = new FakeRepository()
	repository.contacts.set('contact-1', contact)
	return repository
}

describe('drovr list.subscribe (double opt-in confirmation Kit mirror)', () => {
	it('makes the address active on the Kit form and completes to the double-opt-in actor', async () => {
		const repository = setup()
		const subscribeInKit = kit()
		const linkKitSubscriber = vi.fn(async () => undefined)

		const result = await accept({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit,
			linkKitSubscriber,
		})

		expect(subscribeInKit).toHaveBeenCalledWith({
			email: 'learner@example.com',
			firstName: 'Ada',
			kitFormId: 9376133,
		})
		expect(result).toMatchObject({
			status: 'completed',
			completion: {
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'double-opt-in',
				type: 'list.subscribed',
				idempotencyKey:
					'completion:doi:org-aihero:contact-1:skills-newsletter:kit',
				payload: { formId: 'skills-newsletter', kitFormId: 9376133 },
			},
		})
		const [row] = repository.intents.values()
		expect(row).toMatchObject({
			type: 'subscribe-kit-form',
			status: 'completed',
			idempotencyKey: expect.stringMatching(
				/^contact:contact-1:list-subscribe:kit-form:9376133:[0-9a-f]{32}$/,
			),
			metadata: expect.objectContaining({ kitSubscriberId: '4310000001' }),
		})
		expect(linkKitSubscriber).toHaveBeenCalledWith('contact-1', '4310000001')
	})

	it('is idempotent: a redrive answers the same completion without a second Kit call', async () => {
		const repository = setup()
		const subscribeInKit = kit()
		const first = await accept({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit,
		})
		const second = await accept({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit,
		})

		expect(subscribeInKit).toHaveBeenCalledTimes(1)
		expect(second).toEqual(first)
	})

	it('writes again for a new drovr intent, e.g. a later confirmation after an unsubscribe', async () => {
		const repository = setup()
		const subscribeInKit = kit()
		await accept({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit,
		})
		const later = await accept({
			repository,
			intent: confirmation({
				idempotencyKey: 'doi:org-aihero:contact-1:skills-newsletter:kit:2',
			}),
			now,
			subscribeInKit,
		})

		expect(subscribeInKit).toHaveBeenCalledTimes(2)
		expect(repository.intents.size).toBe(2)
		expect(later).toMatchObject({
			status: 'completed',
			completion: {
				idempotencyKey:
					'completion:doi:org-aihero:contact-1:skills-newsletter:kit:2',
			},
		})
	})

	it('names a block, never a success, when Kit keeps the subscriber inactive', async () => {
		const repository = setup()
		const result = await accept({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit: kit(async () => ({
				kitSubscriberId: '4310000001',
				state: 'cancelled',
				unsubscribeTagRemoved: false,
			})),
		})

		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['kit-subscriber-not-active:cancelled'],
		})
	})

	it('retries on a Kit 429 or 5xx and blocks on a Kit 4xx refusal', async () => {
		for (const [status, expected] of [
			[429, { status: 'retry', reason: 'kit-rate-limited' }],
			[503, { status: 'retry', reason: 'kit-retryable' }],
			[
				422,
				{ status: 'blocked', reviewReasons: ['kit-subscribe-refused:422'] },
			],
		] as const) {
			const result = await accept({
				repository: setup(),
				intent: confirmation(),
				now,
				subscribeInKit: kit(async () => {
					throw new KitV4Error(status, 'nope')
				}),
			})
			expect(result).toMatchObject(expected)
		}
		const result = await accept({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit: kit(async () => {
				throw new KitV4Error(429, 'slow down')
			}),
		})
		expect(result).toMatchObject({ retryAfterMs: KIT_SUBSCRIBE_RETRY_MS })
	})

	it('retries without a Kit key and never answers 202', async () => {
		const result = await accept({
			repository: setup(),
			intent: confirmation(),
			now,
		})
		expect(result).toMatchObject({
			status: 'retry',
			reason: 'kit-subscribe-not-configured',
		})
	})

	it('refuses anything but a double-opt-in confirmation onto the Skills form', async () => {
		const subscribeInKit = kit()
		for (const intent of [
			confirmation({ journeyId: 'value-path-skills-course' }),
			confirmation({
				payload: {
					confirmedAt: now,
					formId: 'skills-newsletter',
					kitFormId: 9376133,
					reason: 'imported',
				},
			}),
			confirmation({
				payload: {
					confirmedAt: now,
					formId: 'other',
					kitFormId: 1234,
					reason: 'double-opt-in-confirmed',
				},
			}),
		]) {
			const result = await accept({
				repository: setup(),
				intent,
				now,
				subscribeInKit,
			})
			expect(result.status).toBe('unsupported')
		}
		expect(subscribeInKit).not.toHaveBeenCalled()
	})

	it('answers contact-missing for an unknown contact', async () => {
		const result = await accept({
			repository: new FakeRepository(),
			intent: confirmation(),
			now,
			subscribeInKit: kit(),
		})
		expect(result).toEqual({ status: 'contact-missing' })
	})
})

describe('createKitFormSubscriber (Kit v4)', () => {
	type Call = { method: string; url: string; body?: unknown }
	const fakeKit = (
		answers: Record<string, { status: number; body?: unknown }>,
	) => {
		const calls: Call[] = []
		const fetcher = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			calls.push({
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			})
			const key = `${method} ${new URL(url).pathname}`
			const answer = answers[key] ?? { status: 500 }
			return new Response(
				answer.body === undefined ? null : JSON.stringify(answer.body),
				{ status: answer.status },
			)
		}
		return { calls, fetcher }
	}
	const subscriber = (state = 'active') => ({
		subscriber: { id: 4310000001, state },
	})

	it('upserts active, adds to the form, removes the unsubscribe tag, and reads the state back', async () => {
		const { calls, fetcher } = fakeKit({
			'POST /v4/subscribers': { status: 201, body: subscriber() },
			'POST /v4/forms/9376133/subscribers/4310000001': {
				status: 201,
				body: subscriber(),
			},
			'DELETE /v4/tags/8244351/subscribers/4310000001': { status: 204 },
			'GET /v4/subscribers/4310000001': { status: 200, body: subscriber() },
		})
		const subscribe = createKitFormSubscriber({
			apiKey: 'k',
			fetch: fetcher,
			resubscribeAfterUnsubscribe: true,
		})!

		await expect(
			subscribe({
				email: 'learner@example.com',
				firstName: 'Ada',
				kitFormId: 9376133,
			}),
		).resolves.toEqual({
			kitSubscriberId: '4310000001',
			state: 'active',
			unsubscribeTagRemoved: true,
		})
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
		).toEqual([
			'POST /v4/subscribers',
			'POST /v4/forms/9376133/subscribers/4310000001',
			'DELETE /v4/tags/8244351/subscribers/4310000001',
			'GET /v4/subscribers/4310000001',
		])
		expect(calls[0]?.body).toEqual({
			email_address: 'learner@example.com',
			first_name: 'Ada',
			state: 'active',
		})
	})

	it.each([true, false])(
		'resubscribeAfterUnsubscribe=%s decides whether the unsubscribe tag comes off',
		async (resubscribeAfterUnsubscribe) => {
			const { calls, fetcher } = fakeKit({
				'POST /v4/subscribers': { status: 201, body: subscriber() },
				'POST /v4/forms/9376133/subscribers/4310000001': {
					status: 201,
					body: subscriber(),
				},
				'DELETE /v4/tags/8244351/subscribers/4310000001': { status: 204 },
				'GET /v4/subscribers/4310000001': { status: 200, body: subscriber() },
			})
			const subscribe = createKitFormSubscriber({
				apiKey: 'k',
				fetch: fetcher,
				resubscribeAfterUnsubscribe,
			})!

			const outcome = await subscribe({
				email: 'learner@example.com',
				kitFormId: 9376133,
			})

			const untagged = calls.some((call) => call.method === 'DELETE')
			expect(untagged).toBe(resubscribeAfterUnsubscribe)
			expect(outcome.unsubscribeTagRemoved).toBe(resubscribeAfterUnsubscribe)
		},
	)

	it('defaults to the one switch, DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE', async () => {
		const { calls, fetcher } = fakeKit({
			'POST /v4/subscribers': { status: 201, body: subscriber() },
			'POST /v4/forms/9376133/subscribers/4310000001': {
				status: 201,
				body: subscriber(),
			},
			'DELETE /v4/tags/8244351/subscribers/4310000001': { status: 204 },
			'GET /v4/subscribers/4310000001': { status: 200, body: subscriber() },
		})
		await createKitFormSubscriber({ apiKey: 'k', fetch: fetcher })!({
			email: 'learner@example.com',
			kitFormId: 9376133,
		})
		expect(calls.some((call) => call.method === 'DELETE')).toBe(
			DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE,
		)
	})

	it('treats an untagged subscriber (404 on untag) as fine and reports the real state', async () => {
		const { fetcher } = fakeKit({
			'POST /v4/subscribers': { status: 200, body: subscriber('inactive') },
			'POST /v4/forms/9376133/subscribers/4310000001': {
				status: 200,
				body: subscriber('inactive'),
			},
			'DELETE /v4/tags/8244351/subscribers/4310000001': { status: 404 },
			'GET /v4/subscribers/4310000001': {
				status: 200,
				body: subscriber('inactive'),
			},
		})
		const subscribe = createKitFormSubscriber({ apiKey: 'k', fetch: fetcher })!

		await expect(
			subscribe({ email: 'learner@example.com', kitFormId: 9376133 }),
		).resolves.toMatchObject({
			state: 'inactive',
			unsubscribeTagRemoved: false,
		})
	})

	it('throws KitV4Error with the status on a refusal or an unreadable body', async () => {
		const refused = createKitFormSubscriber({
			apiKey: 'k',
			fetch: fakeKit({ 'POST /v4/subscribers': { status: 422, body: {} } })
				.fetcher,
		})!
		await expect(
			refused({ email: 'learner@example.com', kitFormId: 9376133 }),
		).rejects.toMatchObject({ status: 422 })

		const garbled = createKitFormSubscriber({
			apiKey: 'k',
			fetch: fakeKit({
				'POST /v4/subscribers': { status: 201, body: { nope: 1 } },
			}).fetcher,
		})!
		await expect(
			garbled({ email: 'learner@example.com', kitFormId: 9376133 }),
		).rejects.toMatchObject({ status: 502 })
	})

	it('is absent without an API key', () => {
		expect(createKitFormSubscriber({ apiKey: ' ' })).toBeUndefined()
	})
})

describe('linkKitSubscriberIdentity', () => {
	const repo = (owner?: string, contactKitId?: string) => ({
		findProviderIdentity: vi.fn(async () =>
			owner ? { contactId: owner } : undefined,
		),
		findKitSubscriberIdForContact: vi.fn(async () => contactKitId),
		createProviderIdentity: vi.fn(async () => undefined),
	})

	it('links a new Kit id to a contact that has none', async () => {
		const repository = repo()
		await expect(
			linkKitSubscriberIdentity(repository, 'contact-1', '4310000001', now),
		).resolves.toBe('linked')
		expect(repository.createProviderIdentity).toHaveBeenCalledWith(
			expect.objectContaining({
				contactId: 'contact-1',
				provider: 'kit',
				externalId: '4310000001',
			}),
		)
	})

	it('never takes a Kit id another contact owns, nor adds a second Kit id', async () => {
		for (const [repository, outcome] of [
			[repo('contact-2'), 'kit-id-taken'],
			[repo('contact-1'), 'already-linked'],
			[repo(undefined, '999'), 'contact-has-kit-id'],
		] as const) {
			await expect(
				linkKitSubscriberIdentity(repository, 'contact-1', '4310000001', now),
			).resolves.toBe(outcome)
			expect(repository.createProviderIdentity).not.toHaveBeenCalled()
		}
	})
})

describe('a confirmation lifts an earlier unsubscribe (DOI Q5)', () => {
	const unsubscribedAt = '2026-09-01T00:00:00.000Z'
	const event = (
		eventType: string,
		occurredAt: string,
		extra: Partial<ContactEventRecord> = {},
	) =>
		({
			id: `${eventType}:${occurredAt}`,
			contactId: 'contact-1',
			providerIdentityId: 'identity-kit',
			eventType,
			occurredAt,
			...extra,
		}) as ContactEventRecord

	function lifting(initial: ContactEventRecord[]) {
		const events = [...initial]
		const order: string[] = []
		const requestSync = vi.fn(async () => undefined)
		const recorder = createResubscribeRecorder({
			repository: {
				findContactEventsByType: (_, type) =>
					events.filter((row) => row.eventType === type),
				findValuePathEmailSideEffectIntentsByContact: () => [],
				async createContactEvent(input) {
					order.push('lift')
					if (
						events.some(
							(row) =>
								row.semanticIdempotencyKey === input.semanticIdempotencyKey,
						)
					)
						return
					events.push({ ...input, id: `e${events.length}` } as never)
				},
			},
			findProviderIdentityId: async () => 'identity-any',
			requestSync,
			info: () => undefined,
			now: () => now,
		})
		const subscribeInKit = kit(async () => {
			order.push('kit')
			return {
				kitSubscriberId: '4310000001',
				state: 'active',
				unsubscribeTagRemoved: true,
			}
		})
		return { events, order, recorder, requestSync, subscribeInKit }
	}

	it('records contact.resubscribed at confirmedAt before any Kit call', async () => {
		const f = lifting([event('contact.unsubscribed', unsubscribedAt)])
		const result = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit: f.subscribeInKit,
			recordResubscribe: f.recorder,
		})
		expect(result.status).toBe('completed')
		expect(f.order).toEqual(['lift', 'kit'])
		const lift = f.events.find(
			(row) => row.eventType === 'contact.resubscribed',
		)
		expect(lift).toMatchObject({
			contactId: 'contact-1',
			provider: 'ai-hero',
			providerEventId: resubscribeProviderEventId(
				confirmation().idempotencyKey,
			),
			occurredAt: now,
			providerIdentityId: 'identity-kit',
		})
		expect(f.requestSync).toHaveBeenCalledWith({
			contactId: 'contact-1',
			reason: 'contact-resubscribed',
		})
	})

	it('keeps the lift when Kit then blocks a Kit-cancelled subscriber', async () => {
		const f = lifting([event('contact.unsubscribed', unsubscribedAt)])
		const result = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit: kit(async () => ({
				kitSubscriberId: '4310000001',
				state: 'cancelled',
				unsubscribeTagRemoved: true,
			})),
			recordResubscribe: f.recorder,
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['kit-subscriber-not-active:cancelled'],
		})
		expect(
			f.events.filter((row) => row.eventType === 'contact.resubscribed'),
		).toHaveLength(1)
	})

	it('records nothing for a contact with no active unsubscribe', async () => {
		for (const initial of [
			[],
			[
				event('contact.unsubscribed', unsubscribedAt),
				event('contact.resubscribed', '2026-09-02T00:00:00.000Z'),
			],
			[event('contact.bounced', unsubscribedAt)],
		]) {
			const f = lifting(initial)
			await expect(
				f.recorder({
					contactId: 'contact-1',
					confirmedAt: now,
					intentKey: 'k',
				}),
			).resolves.toBe('not-unsubscribed')
			expect(f.events).toHaveLength(initial.length)
			expect(f.requestSync).not.toHaveBeenCalled()
		}
	})

	it('lifts again after a later unsubscribe, with a new intent', async () => {
		const f = lifting([
			event('contact.unsubscribed', unsubscribedAt),
			event('contact.resubscribed', '2026-09-02T00:00:00.000Z'),
			event('contact.unsubscribed', '2026-09-03T00:00:00.000Z'),
		])
		await expect(
			f.recorder({ contactId: 'contact-1', confirmedAt: now, intentKey: 'k2' }),
		).resolves.toBe('lifted')
	})

	it('blocks, with no lift and no Kit call, a confirmation older than a later unsubscribe', async () => {
		// Confirmed at `now`, then unsubscribed again before the intent arrived.
		const f = lifting([
			event('contact.unsubscribed', unsubscribedAt),
			event('contact.unsubscribed', '2026-09-25T07:00:00.000Z'),
		])
		const result = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit: f.subscribeInKit,
			recordResubscribe: f.recorder,
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['unsubscribed-after-confirmation'],
		})
		expect(f.order).toEqual([])
		expect(
			f.events.filter((row) => row.eventType === 'contact.resubscribed'),
		).toHaveLength(0)
	})

	it('blocks a confirmation with an unsubscribe in the same second (a stop wins a tie)', async () => {
		const f = lifting([
			event('contact.unsubscribed', unsubscribedAt),
			// Stored at whole seconds: the same second as confirmedAt (06:30:00).
			event('contact.unsubscribed', '2026-09-25T06:30:00.000Z'),
		])
		const result = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation({
				payload: {
					confirmedAt: '2026-09-25T06:30:00.250Z',
					formId: 'skills-newsletter',
					kitFormId: 9376133,
					reason: 'double-opt-in-confirmed',
				},
			}),
			now,
			subscribeInKit: f.subscribeInKit,
			recordResubscribe: f.recorder,
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['unsubscribed-after-confirmation'],
		})
		expect(f.order).toEqual([])
	})

	it('blocks, not retries forever, when the contact has no provider identity', async () => {
		const recorder = createResubscribeRecorder({
			repository: {
				findContactEventsByType: () => [],
				findValuePathEmailSideEffectIntentsByContact: () => [
					{
						completedAt: unsubscribedAt,
						createdAt: unsubscribedAt,
						metadata: { providerResult: { unsubscribed: true } },
					} as never,
				],
				createContactEvent: async () => undefined,
			},
			findProviderIdentityId: async () => undefined,
			requestSync: async () => undefined,
			info: () => undefined,
		})
		const subscribeInKit = kit()
		const result = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit,
			recordResubscribe: recorder,
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['resubscribe-lift-no-provider-identity'],
		})
		expect(subscribeInKit).not.toHaveBeenCalled()
	})

	it('blocks a Kit retry of a lifted confirmation after a later unsubscribe', async () => {
		const f = lifting([event('contact.unsubscribed', unsubscribedAt)])
		const repository = setup()
		const first = await acceptDrovrIntent({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit: kit(async () => {
				throw new KitV4Error(503, 'down')
			}),
			recordResubscribe: f.recorder,
		})
		expect(first).toMatchObject({ status: 'retry' })
		f.events.push(event('contact.unsubscribed', '2026-09-25T07:00:00.000Z'))
		const retried = await acceptDrovrIntent({
			repository,
			intent: confirmation(),
			now: '2026-09-25T08:00:00.000Z',
			subscribeInKit: f.subscribeInKit,
			recordResubscribe: f.recorder,
		})
		expect(retried).toMatchObject({
			status: 'blocked',
			reviewReasons: ['unsubscribed-after-confirmation'],
		})
		expect(f.order).toEqual(['lift'])
	})

	it('falls back to any provider identity of the contact', async () => {
		const f = lifting([])
		const recorder = createResubscribeRecorder({
			repository: {
				findContactEventsByType: () => [],
				findValuePathEmailSideEffectIntentsByContact: () => [
					{
						completedAt: unsubscribedAt,
						createdAt: unsubscribedAt,
						metadata: { providerResult: { unsubscribed: true } },
					} as never,
				],
				createContactEvent: async (input) => {
					f.events.push(input as never)
				},
			},
			findProviderIdentityId: async () => 'identity-any',
			requestSync: async () => undefined,
			info: () => undefined,
		})
		await recorder({ contactId: 'contact-1', confirmedAt: now, intentKey: 'k' })
		expect(f.events[0]).toMatchObject({ providerIdentityId: 'identity-any' })
	})

	it('retries, with no Kit call, when the lift cannot be recorded or is not wired', async () => {
		const subscribeInKit = kit()
		const failed = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit,
			recordResubscribe: async () => {
				throw new Error('db down')
			},
		})
		expect(failed).toMatchObject({
			status: 'retry',
			reason: 'resubscribe-lift-failed',
		})
		const unwired = await acceptDrovrIntent({
			repository: setup(),
			intent: confirmation(),
			now,
			subscribeInKit,
		})
		expect(unwired).toMatchObject({
			status: 'retry',
			reason: 'resubscribe-lift-not-configured',
		})
		expect(subscribeInKit).not.toHaveBeenCalled()
	})

	it("accepts drovr's optional resubscribe fields on the payload", async () => {
		const result = await accept({
			repository: setup(),
			intent: confirmation({
				payload: {
					confirmedAt: now,
					formId: 'skills-newsletter',
					kitFormId: 9376133,
					reason: 'double-opt-in-confirmed',
					resubscribe: true,
					liftedScopes: ['all'],
				},
			}),
			now,
			subscribeInKit: kit(),
		})
		expect(result.status).toBe('completed')
	})
})
