import { describe, expect, it, vi } from 'vitest'

import { KitV4Error } from './drovr-evergreen'
import {
	acceptDrovrIntent,
	type DrovrExecutorRepository,
	type DrovrIntent,
} from './drovr-executor'
import {
	createKitFormSubscriber,
	KIT_SUBSCRIBE_RETRY_MS,
	linkKitSubscriberIdentity,
	type KitFormSubscriber,
} from './drovr-list-subscribe'
import type { ContactRecord, SideEffectIntent } from './types'

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

		const result = await acceptDrovrIntent({
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
			idempotencyKey: 'contact:contact-1:list-subscribe:kit-form:9376133',
			metadata: expect.objectContaining({ kitSubscriberId: '4310000001' }),
		})
		expect(linkKitSubscriber).toHaveBeenCalledWith('contact-1', '4310000001')
	})

	it('is idempotent: a redrive answers the same completion without a second Kit call', async () => {
		const repository = setup()
		const subscribeInKit = kit()
		const first = await acceptDrovrIntent({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit,
		})
		const second = await acceptDrovrIntent({
			repository,
			intent: confirmation(),
			now,
			subscribeInKit,
		})

		expect(subscribeInKit).toHaveBeenCalledTimes(1)
		expect(second).toEqual(first)
	})

	it('names a block, never a success, when Kit keeps the subscriber inactive', async () => {
		const repository = setup()
		const result = await acceptDrovrIntent({
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
			const result = await acceptDrovrIntent({
				repository: setup(),
				intent: confirmation(),
				now,
				subscribeInKit: kit(async () => {
					throw new KitV4Error(status, 'nope')
				}),
			})
			expect(result).toMatchObject(expected)
		}
		const result = await acceptDrovrIntent({
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
		const result = await acceptDrovrIntent({
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
			const result = await acceptDrovrIntent({
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
		const result = await acceptDrovrIntent({
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
		const subscribe = createKitFormSubscriber({ apiKey: 'k', fetch: fetcher })!

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
