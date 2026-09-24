import { describe, expect, it, vi } from 'vitest'

import { AI_HERO_UNSUBSCRIBED_TAG_ID } from './ai-hero-email-opt-in'
import { KitV4Error } from './drovr-evergreen'
import {
	acceptDrovrIntent,
	type DrovrExecutorRepository,
	type DrovrIntent,
} from './drovr-executor'
import {
	createKitUnsubscriber,
	KIT_UNSUBSCRIBE_RETRY_MS,
	type KitUnsubscriber,
} from './drovr-list-unsubscribe'
import type { ContactRecord, SideEffectIntent } from './types'

const now = '2026-09-24T15:00:00.000Z'

const kitMock = (impl?: KitUnsubscriber) =>
	impl
		? vi.fn<Parameters<KitUnsubscriber>, ReturnType<KitUnsubscriber>>(impl)
		: vi.fn<Parameters<KitUnsubscriber>, ReturnType<KitUnsubscriber>>()

class FakeRepository implements DrovrExecutorRepository {
	contacts = new Map<string, ContactRecord>()
	intents = new Map<string, SideEffectIntent>()
	raceRows: SideEffectIntent[] = []

	findContactById(id: string) {
		return this.contacts.get(id)
	}
	findSideEffectIntentByIdempotencyKey(idempotencyKey: string) {
		return Array.from(this.intents.values()).find(
			(intent) => intent.idempotencyKey === idempotencyKey,
		)
	}
	createSideEffectIntent(input: SideEffectIntent) {
		for (const row of this.raceRows.splice(0)) this.intents.set(row.id, row)
		if (this.findSideEffectIntentByIdempotencyKey(input.idempotencyKey)) {
			throw new Error(
				"Duplicate entry for key 'SideEffectIntent_idempotencyKey_uq'",
			)
		}
		this.intents.set(input.id, input)
		return input
	}
	findValuePathEmailSideEffectIntentsByContact() {
		return []
	}
	claimSideEffectIntentForSend(id: string, args: { now: string; staleAfterMs: number }) {
		const row = this.intents.get(id)
		if (!row) return false
		const staleClaim =
			row.status === 'sending' &&
			Date.parse(String(row.metadata.claimedAt)) < Date.parse(args.now) - args.staleAfterMs
		if (row.status !== 'pending' && row.status !== 'failed' && !staleClaim) return false
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
		if (row?.status !== 'sending' || row.metadata.claimedAt !== claimedAt) return undefined
		const next = { ...row, ...patch }
		this.intents.set(id, next)
		return next
	}
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata' | 'completedAt'
		>,
	) {
		const row = this.intents.get(id)
		if (!row) throw new Error(`no row ${id}`)
		const next = { ...row, ...patch }
		this.intents.set(id, next)
		return next
	}
}

const contact = (overrides: Partial<ContactRecord> = {}): ContactRecord => ({
	id: 'contact-1',
	email: 'learner@example.com',
	name: 'Learner',
	lifecycle: 'nurture-ready',
	isProvisional: false,
	createdAt: now,
	updatedAt: now,
	...overrides,
})

const intent = (overrides: Partial<DrovrIntent> = {}): DrovrIntent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'contact-directory',
	kind: 'list.unsubscribe',
	idempotencyKey: 'unsubscribe:org-aihero:contact-1:all',
	dueAt: now,
	payload: { scope: 'all', source: 'page' },
	...overrides,
})

const setup = () => {
	const repository = new FakeRepository()
	repository.contacts.set('contact-1', contact())
	return repository
}

describe('acceptDrovrIntent: list.unsubscribe', () => {
	it('tags the subscriber Unsubscribed: AI Hero and answers the completion to the asking actor', async () => {
		const repository = setup()
		const unsubscribeInKit = kitMock(async () => 'tagged')

		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit,
			findKitSubscriberId: async () => '123456',
		})

		expect(unsubscribeInKit).toHaveBeenCalledWith({
			email: 'learner@example.com',
			kitSubscriberId: '123456',
		})
		expect(result.status).toBe('completed')
		if (result.status !== 'completed') return
		expect(result.completion).toEqual({
			tenantId: 'org-aihero',
			contactId: 'contact-1',
			journeyId: 'contact-directory',
			type: 'list.unsubscribed',
			occurredAt: now,
			idempotencyKey: 'completion:unsubscribe:org-aihero:contact-1:all',
			payload: { scope: 'all' },
		})
		const row = repository.findSideEffectIntentByIdempotencyKey(
			'contact:contact-1:list-unsubscribe:all',
		)
		expect(row).toMatchObject({
			type: 'unsubscribe-kit-list',
			provider: 'kit',
			status: 'completed',
			metadata: {
				scope: 'all',
				unsubscribeSource: 'page',
				kitCall: 'tagged',
				kitTagId: AI_HERO_UNSUBSCRIBED_TAG_ID,
				drovr: { tenantId: 'org-aihero', journeyId: 'contact-directory' },
			},
		})
	})

	it('claims one row before a concurrent all-scope Kit write', async () => {
		const repository = setup()
		const unsubscribeInKit = kitMock(async () => {
			await Promise.resolve()
			return 'tagged'
		})
		const [first, second] = await Promise.all([
			acceptDrovrIntent({ repository, intent: intent(), now, unsubscribeInKit }),
			acceptDrovrIntent({ repository, intent: intent(), now, unsubscribeInKit }),
		])

		expect(unsubscribeInKit).toHaveBeenCalledTimes(1)
		expect(repository.intents.size).toBe(1)
		expect(
			repository.findSideEffectIntentByIdempotencyKey(
				'contact:contact-1:list-unsubscribe:all',
			)?.status,
		).toBe('completed')
		expect([first.status, second.status]).toContain('completed')
	})

	it('a stale Kit failure cannot overwrite a newer successful claim', async () => {
		const repository = setup()
		let rejectOld!: (reason: Error) => void
		const oldKit = kitMock(
			() => new Promise<'tagged'>((_resolve, reject) => { rejectOld = reject }),
		)
		const first = acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit: oldKit,
		})
		await vi.waitFor(() => expect(oldKit).toHaveBeenCalledTimes(1))

		const newer = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now: '2026-09-24T15:11:00.000Z',
			unsubscribeInKit: kitMock(async () => 'tagged'),
		})
		expect(newer.status).toBe('completed')
		rejectOld(new KitV4Error(429, 'late failure'))
		const stale = await first
		expect(stale.status).toBe('completed')
		expect(
			repository.findSideEffectIntentByIdempotencyKey(
				'contact:contact-1:list-unsubscribe:all',
			)?.status,
		).toBe('completed')
	})

	it('is idempotent: a repeat answers the stored completion without calling Kit again', async () => {
		const repository = setup()
		const unsubscribeInKit = kitMock(async () => 'tagged')
		await acceptDrovrIntent({ repository, intent: intent(), now, unsubscribeInKit })

		const repeat = await acceptDrovrIntent({
			repository,
			intent: intent({ journeyId: 'value-path-skills-course' }),
			now: '2026-09-24T16:00:00.000Z',
			unsubscribeInKit,
		})

		expect(unsubscribeInKit).toHaveBeenCalledTimes(1)
		expect(repository.intents.size).toBe(1)
		expect(repeat.status).toBe('completed')
		if (repeat.status !== 'completed') return
		// Addressed to the actor that asked this time, dated when Kit was written.
		expect(repeat.completion.journeyId).toBe('value-path-skills-course')
		expect(repeat.completion.occurredAt).toBe(now)
	})

	it('completes a course scope with a receipt row and no Kit call', async () => {
		const repository = setup()
		const unsubscribeInKit = kitMock(async () => 'tagged')

		const result = await acceptDrovrIntent({
			repository,
			intent: intent({
				journeyId: 'value-path-skills-course',
				idempotencyKey: 'unsubscribe:org-aihero:contact-1:course',
				payload: { scope: 'course', source: 'page' },
			}),
			now,
			unsubscribeInKit,
		})

		expect(unsubscribeInKit).not.toHaveBeenCalled()
		expect(result.status).toBe('completed')
		expect(
			repository.findSideEffectIntentByIdempotencyKey(
				'contact:contact-1:list-unsubscribe:course:value-path-skills-course',
			)?.metadata.kitCall,
		).toBe('none')
	})

	it('answers retry on a Kit rate limit and completes on the re-ask', async () => {
		const repository = setup()
		const unsubscribeInKit = kitMock()
			.mockRejectedValueOnce(new KitV4Error(429, 'slow down'))
			.mockResolvedValueOnce('already-tagged')

		const first = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit,
		})
		expect(first).toMatchObject({
			status: 'retry',
			retryAfterMs: KIT_UNSUBSCRIBE_RETRY_MS,
			reason: 'kit-rate-limited',
		})
		expect(
			repository.findSideEffectIntentByIdempotencyKey(
				'contact:contact-1:list-unsubscribe:all',
			)?.status,
		).toBe('failed')

		const tooEarly = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit,
		})
		expect(tooEarly).toMatchObject({ status: 'retry', reason: 'kit-unsubscribe-retry-due' })
		expect(unsubscribeInKit).toHaveBeenCalledTimes(1)

		const second = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now: '2026-09-24T15:01:00.000Z',
			unsubscribeInKit,
		})
		expect(second.status).toBe('completed')
		expect(repository.intents.size).toBe(1)
	})

	it('answers retry on a network failure or 5xx', async () => {
		for (const failure of [new TypeError('fetch failed'), new KitV4Error(502, 'x')]) {
			const repository = setup()
			const result = await acceptDrovrIntent({
				repository,
				intent: intent(),
				now,
				unsubscribeInKit: async () => {
					throw failure
				},
			})
			expect(result).toMatchObject({ status: 'retry', reason: 'kit-retryable' })
		}
	})

	it('blocks with a named reason when Kit refuses outright', async () => {
		const repository = setup()
		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit: async () => {
				throw new KitV4Error(422, 'refused')
			},
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['kit-unsubscribe-refused:422'],
		})
	})

	it('blocks a contact with no email instead of guessing', async () => {
		const repository = setup()
		repository.contacts.set('contact-1', contact({ email: null }))
		const unsubscribeInKit = kitMock(async () => 'tagged')
		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit,
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['contact-email-missing'],
		})
		expect(unsubscribeInKit).not.toHaveBeenCalled()
	})

	it('answers retry while the deployment has no Kit key', async () => {
		const result = await acceptDrovrIntent({
			repository: setup(),
			intent: intent(),
			now,
		})
		expect(result).toMatchObject({
			status: 'retry',
			reason: 'kit-unsubscribe-not-configured',
		})
	})

	it('survives a duplicate-insert race by using the row that won', async () => {
		const repository = setup()
		repository.raceRows.push({
			id: 'raced-row',
			nextActionId: 'drovr:raced',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'unsubscribe-kit-list',
			status: 'pending',
			idempotencyKey: 'contact:contact-1:list-unsubscribe:all',
			gates: [],
			reviewReasons: [],
			metadata: { scope: 'all' },
			createdAt: now,
		})
		const result = await acceptDrovrIntent({
			repository,
			intent: intent(),
			now,
			unsubscribeInKit: async () => 'tagged',
		})
		expect(result).toMatchObject({ status: 'completed', intentId: 'raced-row' })
	})

	it('refuses a payload without a scope, and unknown contacts', async () => {
		const repository = setup()
		expect(
			(
				await acceptDrovrIntent({
					repository,
					intent: intent({ payload: { source: 'page' } }),
					now,
				})
			).status,
		).toBe('unsupported')
		expect(
			(
				await acceptDrovrIntent({
					repository,
					intent: intent({ contactId: 'nobody' }),
					now,
				})
			).status,
		).toBe('contact-missing')
	})
})

describe('createKitUnsubscriber', () => {
	const respond = (status: number) =>
		vi.fn(async () => new Response('{}', { status }))

	it('is absent without a key, so the executor answers retry', () => {
		expect(createKitUnsubscriber({ apiKey: '  ' })).toBeUndefined()
	})

	it('tags by Kit subscriber id when known, by email otherwise', async () => {
		const fetch = respond(201)
		const unsubscribe = createKitUnsubscriber({ apiKey: 'kit-key', fetch })!

		expect(
			await unsubscribe({ email: 'learner@example.com', kitSubscriberId: '42' }),
		).toBe('tagged')
		expect(await unsubscribe({ email: 'learner@example.com' })).toBe('tagged')

		const [byId, byEmail] = fetch.mock.calls as unknown as [
			[string, RequestInit],
			[string, RequestInit],
		]
		expect(byId[0]).toBe(
			`https://api.kit.com/v4/tags/${AI_HERO_UNSUBSCRIBED_TAG_ID}/subscribers/42`,
		)
		expect(byId[1].body).toBe('{}')
		expect(byEmail[0]).toBe(
			`https://api.kit.com/v4/tags/${AI_HERO_UNSUBSCRIBED_TAG_ID}/subscribers`,
		)
		expect(JSON.parse(String(byEmail[1].body))).toEqual({
			email_address: 'learner@example.com',
		})
		expect(byEmail[1].headers).toMatchObject({ 'X-Kit-Api-Key': 'kit-key' })
	})

	it('maps 200 to already-tagged, 404 to not-in-kit, and throws the rest', async () => {
		const subscriber = { email: 'learner@example.com' }
		expect(
			await createKitUnsubscriber({ apiKey: 'k', fetch: respond(200) })!(
				subscriber,
			),
		).toBe('already-tagged')
		expect(
			await createKitUnsubscriber({ apiKey: 'k', fetch: respond(404) })!(
				subscriber,
			),
		).toBe('not-in-kit')
		await expect(
			createKitUnsubscriber({ apiKey: 'k', fetch: respond(429) })!(subscriber),
		).rejects.toMatchObject({ status: 429 })
	})
})
