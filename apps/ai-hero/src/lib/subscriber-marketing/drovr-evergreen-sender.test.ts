import { describe, expect, it } from 'vitest'

import {
	EVERGREEN_SEND_MAX_ATTEMPTS,
	executePendingEvergreenSends,
	type EvergreenSenderRepository,
} from './drovr-evergreen-sender'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from './dry-run'
import { codingWorkflowFixture } from './__fixtures__/quick-question-fixtures'
import type { ContactEventRecord, ContactRecord, SideEffectIntent } from './types'

const now = '2026-09-17T16:00:00.000Z'

class FakeRepository implements EvergreenSenderRepository {
	contacts = new Map<string, ContactRecord>()
	intents = new Map<string, SideEffectIntent>()
	shadowNewsletterAssigned = false
	/** Stop event types the contact has (contact.unsubscribed and so on). */
	stops = new Set<string>()
	findContactById(id: string) {
		return this.contacts.get(id)
	}
	findContactEventsByType(
		_contactId: string,
		eventType: string,
	): ContactEventRecord[] {
		if (this.stops.has(eventType)) {
			return [{ id: `stop-${eventType}`, eventType } as ContactEventRecord]
		}
		if (!this.shadowNewsletterAssigned || eventType !== 'journey.owner.assigned') {
			return []
		}
		return [
			{
				id: 'newsletter-owner-1',
				contactId: 'contact-1',
				providerIdentityId: 'identity-1',
				provider: 'kit',
				providerEventId: 'drovr-owner:contact-1:shadow-newsletter',
				providerReference: 'drovr-owner:contact-1:shadow-newsletter',
				eventType: 'journey.owner.assigned',
				occurredAt: now,
				createdAt: now,
				semanticIdempotencyKey: 'owner:contact-1:shadow-newsletter',
				privacyLevel: 'internal',
				identityEvidence: {
					source: 'kit',
					strength: 'strong',
					providerIdentity: { provider: 'kit', externalId: 'kit-1' },
				},
				payloadSummary: {
					summary: 'owner assignment',
					keywords: [],
					restrictedPayloadStored: false,
				},
				schemaVersion: 1,
			},
		]
	}
	findPendingSideEffectIntentsByType(
		type: SideEffectIntent['type'],
		limit: number,
	) {
		return Array.from(this.intents.values())
			.filter((row) => row.type === type && row.status === 'pending')
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.slice(0, limit)
	}
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> &
			Partial<Pick<SideEffectIntent, 'completedAt'>>,
	) {
		const row = this.intents.get(id)
		if (!row) throw new Error(`no row ${id}`)
		const next = { ...row, ...patch }
		this.intents.set(id, next)
		return next
	}
}

const contact = (): ContactRecord => ({
	id: 'contact-1',
	email: 'learner@example.com',
	name: 'Learner',
	lifecycle: 'nurture-ready',
	isProvisional: false,
	createdAt: now,
	updatedAt: now,
})

const row = (overrides: Partial<SideEffectIntent> = {}): SideEffectIntent => ({
	id: 'row-1',
	nextActionId: 'drovr:abc',
	contactId: 'contact-1',
	provider: 'kit',
	type: 'send-evergreen-email',
	status: 'pending',
	idempotencyKey: 'contact:contact-1:evergreen:bridge_can_engineer_v1',
	gates: [],
	reviewReasons: [],
	metadata: {
		source: 'drovr',
		messageId: 'bridge_can_engineer_v1',
		slot: 'B1',
		kitSequenceId: '2887679',
		drovr: {
			tenantId: 'org-aihero',
			journeyId: 'crash-course-evergreen-offer',
			intentKey: 'k1',
		},
	},
	createdAt: '2026-09-17T15:59:00.000Z',
	...overrides,
})

describe('executePendingEvergreenSends', () => {
	it('adds the contact to the slot sequence, completes the row, and dispatches it', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set('row-1', row())
		const subscribes: unknown[] = []
		const dispatched: SideEffectIntent[] = []
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async (input) => {
				subscribes.push(input)
				return {}
			},
			limit: 10,
			now: () => now,
			dispatch: (intent) => dispatched.push(intent),
		})
		expect(results).toEqual([
			{ status: 'completed', intentId: 'row-1', kitSequenceId: '2887679' },
		])
		expect(subscribes).toEqual([
			{
				listId: '2887679',
				listType: 'sequence',
				user: { email: 'learner@example.com', name: 'Learner' },
			},
		])
		expect(repository.intents.get('row-1')).toMatchObject({
			status: 'completed',
			completedAt: now,
			metadata: { completedAt: now, messageId: 'bridge_can_engineer_v1' },
		})
		expect(dispatched.map((d) => d.status)).toEqual(['completed'])
	})

	it('adds a shadow-newsletter contact to its pinned one-email sequence', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set(
			'row-shadow',
			row({
				id: 'row-shadow',
				type: 'send-shadow-newsletter-email',
				idempotencyKey:
					'contact:contact-1:shadow-newsletter:agents_md_big_problem_v1',
				metadata: {
					source: 'drovr',
					newsletter: 'shadow-newsletter',
					catalogRevision: 'kit-2625552-2026-09-19',
					messageId: 'agents_md_big_problem_v1',
					position: 0,
					kitSequenceId: '2899143',
					drovr: {
						tenantId: 'org-aihero-shadow',
						journeyId: 'shadow-newsletter',
						intentKey: 'k-shadow',
					},
				},
			}),
		)
		const subscribes: unknown[] = []
		const dispatched: SideEffectIntent[] = []
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async (input) => {
				subscribes.push(input)
				return 'added'
			},
			limit: 10,
			now: () => now,
			dispatch: (intent) => dispatched.push(intent),
			type: 'send-shadow-newsletter-email',
			oldNewsletterExit: async () => {},
		})
		expect(results).toEqual([
			{ status: 'completed', intentId: 'row-shadow', kitSequenceId: '2899143' },
		])
		expect(subscribes).toEqual([
			{
				listId: '2899143',
				listType: 'sequence',
				user: { email: 'learner@example.com', name: 'Learner' },
			},
		])
		expect(repository.intents.get('row-shadow')).toMatchObject({
			status: 'completed',
			metadata: { completedAt: now, messageId: 'agents_md_big_problem_v1' },
		})
		expect(dispatched).toHaveLength(1)
	})

	it('keeps a failed Kit write pending with the attempt and error recorded', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set('row-1', row())
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async () => {
				throw Object.assign(
					new Error('AIH_KIT_SUBSCRIBE_ERROR:rate-limited:429'),
					{
						status: 429,
					},
				)
			},
			limit: 10,
			dispatch: () => {},
		})
		expect(results).toEqual([
			{
				status: 'retry',
				intentId: 'row-1',
				attempts: 1,
				error: 'AIH_KIT_SUBSCRIBE_ERROR:rate-limited:429',
			},
		])
		expect(repository.intents.get('row-1')).toMatchObject({
			status: 'pending',
			metadata: {
				attempts: 1,
				lastError: 'AIH_KIT_SUBSCRIBE_ERROR:rate-limited:429',
			},
		})
	})

	it('marks the row failed once the attempt budget is spent', async () => {
		const repository = new FakeRepository()
		const dispatched: SideEffectIntent[] = []
		repository.contacts.set('contact-1', contact())
		repository.intents.set(
			'row-1',
			row({
				metadata: {
					...row().metadata,
					attempts: EVERGREEN_SEND_MAX_ATTEMPTS - 1,
				},
			}),
		)
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async () => {
				throw new Error('still down')
			},
			limit: 10,
			now: () => now,
			dispatch: (intent) => dispatched.push(intent),
		})
		expect(results[0]).toMatchObject({ status: 'failed', intentId: 'row-1' })
		expect(dispatched).toEqual([repository.intents.get('row-1')])
		expect(dispatched[0]?.metadata.failedAt).toBe(now)
		expect(repository.intents.get('row-1')).toMatchObject({
			status: 'failed',
			reviewReasons: ['evergreen-send-exhausted'],
		})
	})

	it('goes terminal on a 4xx Kit answer and retries on 429, 5xx, and network errors', async () => {
		const run = async (error: unknown) => {
			const repository = new FakeRepository()
			repository.contacts.set('contact-1', contact())
			repository.intents.set('row-1', row())
			const results = await executePendingEvergreenSends({
				repository,
				subscribe: async () => {
					throw error
				},
				limit: 10,
				dispatch: () => {},
			})
			return { result: results[0], row: repository.intents.get('row-1') }
		}
		const inactive = await run(Object.assign(new Error('422'), { status: 422 }))
		expect(inactive.result).toMatchObject({ status: 'failed' })
		expect(inactive.row).toMatchObject({
			status: 'failed',
			reviewReasons: ['kit-422'],
		})
		for (const error of [
			Object.assign(new Error('429'), { status: 429 }),
			Object.assign(new Error('503'), { status: 503 }),
			new TypeError('fetch failed'),
		]) {
			const outcome = await run(error)
			expect(outcome.result).toMatchObject({ status: 'retry', attempts: 1 })
			expect(outcome.row?.status).toBe('pending')
		}
	})
	it('fails a row whose contact has no email without touching Kit', async () => {
		const repository = new FakeRepository()
		repository.intents.set('row-1', row())
		let calls = 0
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async () => {
				calls += 1
				return {}
			},
			limit: 10,
			dispatch: () => {},
		})
		expect(calls).toBe(0)
		expect(results[0]).toMatchObject({
			status: 'failed',
			error: 'contact-email-missing',
		})
	})

	describe('never enrolls a stopped contact (qi0sd, 2026-09-27)', () => {
		// A contact unsubscribed through Kit on 09-21 was added to a
		// shadow-newsletter sequence on 09-24: drovr had no suppression row
		// yet, and this sender never read ai-hero's own stops.
		const types = [
			['send-evergreen-email', '2887679'],
			['send-shadow-newsletter-email', '2899143'],
			['subscribe-evergreen-list', '2887700'],
		] as const
		const stops = [
			['contact.unsubscribed', 'unsubscribed'],
			['contact.bounced', 'bounced'],
			['contact.complained', 'complained'],
		] as const
		for (const [type, sequence] of types)
			for (const [stop, reason] of stops)
				it(`refuses ${type} for a contact with ${stop}, never touching Kit`, async () => {
					const repository = new FakeRepository()
					repository.contacts.set('contact-1', contact())
					repository.stops.add(stop)
					repository.intents.set(
						'row-1',
						row({ type, metadata: { ...row().metadata, kitSequenceId: sequence } }),
					)
					let calls = 0
					const dispatched: SideEffectIntent[] = []
					const results = await executePendingEvergreenSends({
						repository,
						type,
						subscribe: async () => {
							calls += 1
							return {}
						},
						limit: 10,
						now: () => now,
						dispatch: (intent) => dispatched.push(intent),
					})
					expect(calls).toBe(0)
					expect(results).toEqual([
						{ status: 'failed', intentId: 'row-1', error: reason },
					])
					expect(repository.intents.get('row-1')).toMatchObject({
						status: 'failed',
						reviewReasons: [reason],
					})
					expect(dispatched.map((d) => d.status)).toEqual(['failed'])
				})

		it('refuses a stopped contact\'s shadow-newsletter handoff too (no birth)', async () => {
			const repository = new FakeRepository()
			repository.contacts.set('contact-1', contact())
			repository.shadowNewsletterAssigned = true
			repository.stops.add('contact.unsubscribed')
			repository.intents.set(
				'row-1',
				row({
					type: 'subscribe-evergreen-list',
					metadata: { ...row().metadata, list: 'shadow-newsletter' },
				}),
			)
			const results = await executePendingEvergreenSends({
				repository,
				type: 'subscribe-evergreen-list',
				subscribe: async () => ({}),
				limit: 10,
				now: () => now,
				dispatch: () => {},
			})
			expect(results).toEqual([
				{ status: 'failed', intentId: 'row-1', error: 'unsubscribed' },
			])
		})
	})

	it('refuses an unsubscribed contact with the production repository shape', async () => {
		// The in-memory capture repository, as the sender runs on Drizzle's.
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-09-20T10:00:00.000Z',
		})
		repository.createContactEvent({
			contactId: captured.contact.id,
			providerIdentityId: captured.providerIdentity.id,
			provider: 'kit',
			providerEventId: 'email-preference-opt-out:newsletter:x',
			providerReference: 'kit:email-preference:newsletter',
			eventType: 'contact.unsubscribed',
			occurredAt: '2026-09-21T11:19:09.000Z',
			semanticIdempotencyKey: 'unsubscribe-newsletter',
			privacyLevel: 'internal',
			identityEvidence: captured.providerIdentity.evidence,
			payloadSummary: {
				summary: 'Unsubscribed',
				keywords: ['contact-unsubscribed'],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
			createdAt: '2026-09-21T11:19:09.000Z',
		})
		repository.createSideEffectIntent(
			row({
				id: 'shadow-send-1',
				contactId: captured.contact.id,
				type: 'send-shadow-newsletter-email',
				metadata: { ...row().metadata, kitSequenceId: '2899143' },
				createdAt: '2026-09-24T18:01:49.000Z',
			}),
		)
		let calls = 0
		const results = await executePendingEvergreenSends({
			repository,
			type: 'send-shadow-newsletter-email',
			subscribe: async () => {
				calls += 1
				return {}
			},
			limit: 10,
			now: () => '2026-09-24T18:26:49.000Z',
			dispatch: () => {},
		})
		expect(calls).toBe(0)
		expect(results).toEqual([
			{ status: 'failed', intentId: 'shadow-send-1', error: 'unsubscribed' },
		])
	})

	describe('a fresh double opt-in lifts an unsubscribe (DOI Q5)', () => {
		async function sendsWith(stops: [string, string][]) {
			const repository = new InMemorySubscriberMarketingRepository()
			const captured = await dryRunSubscriberMarketingFixture({
				repository,
				fixture: codingWorkflowFixture,
				now: '2026-09-20T10:00:00.000Z',
			})
			for (const [eventType, occurredAt] of stops)
				repository.createContactEvent({
					contactId: captured.contact.id,
					providerIdentityId: captured.providerIdentity.id,
					provider: 'kit',
					providerEventId: `${eventType}:${occurredAt}`,
					providerReference: `kit:${eventType}`,
					eventType,
					occurredAt,
					semanticIdempotencyKey: `${eventType}:${occurredAt}`,
					privacyLevel: 'internal',
					identityEvidence: captured.providerIdentity.evidence,
					payloadSummary: {
						summary: eventType,
						keywords: [],
						restrictedPayloadStored: false,
					},
					schemaVersion: 1,
					createdAt: occurredAt,
				})
			repository.createSideEffectIntent(
				row({
					id: 'send-1',
					contactId: captured.contact.id,
					type: 'send-evergreen-email',
					metadata: { ...row().metadata, kitSequenceId: '2887679' },
					createdAt: '2026-09-24T18:01:49.000Z',
				}),
			)
			let calls = 0
			const results = await executePendingEvergreenSends({
				repository,
				type: 'send-evergreen-email',
				subscribe: async () => {
					calls += 1
					return {}
				},
				limit: 10,
				now: () => '2026-09-24T18:26:49.000Z',
				dispatch: () => {},
			})
			return { calls, results }
		}

		it('sends to a contact whose unsubscribe a later confirmation lifted', async () => {
			const { calls, results } = await sendsWith([
				['contact.unsubscribed', '2026-09-21T11:19:09.000Z'],
				['contact.resubscribed', '2026-09-22T09:00:00.000Z'],
			])
			expect(calls).toBe(1)
			expect(results).toMatchObject([{ status: 'completed' }])
		})

		it('refuses again after a later unsubscribe', async () => {
			const { calls, results } = await sendsWith([
				['contact.unsubscribed', '2026-09-21T11:19:09.000Z'],
				['contact.resubscribed', '2026-09-22T09:00:00.000Z'],
				['contact.unsubscribed', '2026-09-23T09:00:00.000Z'],
			])
			expect(calls).toBe(0)
			expect(results).toMatchObject([
				{ status: 'failed', error: 'unsubscribed' },
			])
		})

		it('never lifts a bounce', async () => {
			const { calls, results } = await sendsWith([
				['contact.bounced', '2026-09-21T11:19:09.000Z'],
				['contact.resubscribed', '2026-09-22T09:00:00.000Z'],
			])
			expect(calls).toBe(0)
			expect(results).toMatchObject([{ status: 'failed', error: 'bounced' }])
		})
	})

	it('paces between rows and honours the limit', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		for (const id of ['a', 'b', 'c']) {
			repository.intents.set(
				id,
				row({
					id,
					createdAt: `2026-09-17T15:5${id === 'a' ? 7 : id === 'b' ? 8 : 9}:00.000Z`,
				}),
			)
		}
		const sleeps: number[] = []
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async () => ({}),
			limit: 2,
			pacingMs: 250,
			sleep: async (ms) => {
				sleeps.push(ms)
			},
			dispatch: () => {},
		})
		expect(results.map((r) => r.intentId)).toEqual(['a', 'b'])
		expect(sleeps).toEqual([250])
	})

	it('skips Kit for an assigned shadow-newsletter handoff and still emits its birth', async () => {
		const repository = new FakeRepository()
		repository.shadowNewsletterAssigned = true
		repository.contacts.set('contact-1', contact())
		repository.intents.set(
			'row-assigned',
			row({
				id: 'row-assigned',
				type: 'subscribe-evergreen-list',
				idempotencyKey: 'contact:contact-1:evergreen:list:shadow-newsletter',
				metadata: {
					source: 'drovr',
					list: 'shadow-newsletter',
					kitSequenceId: '2625552',
					drovr: {
						tenantId: 'org-aihero',
						journeyId: 'crash-course-evergreen-offer',
						intentKey: 'k-assigned',
					},
				},
			}),
		)
		const subscribes: unknown[] = []
		const dispatched: SideEffectIntent[] = []
		const results = await executePendingEvergreenSends({
			repository,
			subscribe: async (input) => {
				subscribes.push(input)
				return 'must-not-add'
			},
			limit: 10,
			now: () => now,
			dispatch: (intent) => dispatched.push(intent),
			oldNewsletterExit: async () => {},
			type: 'subscribe-evergreen-list',
		})

		expect(results).toEqual([
			{ status: 'completed', intentId: 'row-assigned', kitSequenceId: '2625552' },
		])
		expect(subscribes).toEqual([])
		expect(repository.intents.get('row-assigned')).toMatchObject({
			status: 'completed',
			metadata: {
				kitSkipped: 'shadow-newsletter-owner-assignment',
				completedAt: now,
			},
		})
		const events = mapDrovrShadowFact({
			kind: 'side-effect-intent-completed',
			intent: dispatched[0]!,
		})
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					journeyId: 'shadow-newsletter',
					type: 'contact.created',
				}),
			]),
		)
	})

	it('drains subscribe-evergreen-list rows when asked for that type and leaves sends alone', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set('row-1', row())
		repository.intents.set(
			'row-2',
			row({
				id: 'row-2',
				type: 'subscribe-evergreen-list',
				idempotencyKey: 'contact:contact-1:evergreen:list:shadow-newsletter',
				metadata: {
					source: 'drovr',
					list: 'shadow-newsletter',
					kitSequenceId: '2625552',
					drovr: {
						tenantId: 'org-aihero',
						journeyId: 'crash-course-evergreen-offer',
						intentKey: 'k-list',
					},
				},
			}),
		)
		const subscribes: unknown[] = []
		const results = await executePendingEvergreenSends({
			repository,
			type: 'subscribe-evergreen-list',
			subscribe: async (input) => {
				subscribes.push(input)
				return 'already-added'
			},
			limit: 10,
			now: () => now,
			dispatch: () => {},
		})
		expect(results.map((r) => [r.intentId, r.status])).toEqual([
			['row-2', 'completed'],
		])
		expect(subscribes).toMatchObject([{ listId: '2625552' }])
		expect(repository.intents.get('row-1')?.status).toBe('pending')
		expect(repository.intents.get('row-2')?.status).toBe('completed')
	})
})

describe('explicit newsletter-only first429/pause mode', () => {
	const fixture = (attempts = 0) => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', { ...contact(), email: 'newsletter-synthetic@aih.test.invalid' })
		for (const id of ['a', 'b', 'c']) repository.intents.set(id, row({
			id, type: 'send-shadow-newsletter-email',
			createdAt: `2026-09-17T15:59:0${id === 'a' ? 0 : id === 'b' ? 1 : 2}.000Z`,
			metadata: { ...row().metadata, attempts },
		}))
		return repository
	}
	const run = (repository: FakeRepository, extra: Partial<Parameters<typeof executePendingEvergreenSends>[0]> = {}) =>
		executePendingEvergreenSends({ repository, type: 'send-shadow-newsletter-email',
			limit: 120, now: () => now, sleep: async () => {}, dispatch: () => {}, subscribe: async () => 'added', ...extra,
		})
	it.each([0, EVERGREEN_SEND_MAX_ATTEMPTS - 1, EVERGREEN_SEND_MAX_ATTEMPTS, 10])(
		'first429 after success stops remaining rows and spends no attempt, prior=%s', async attempts => {
			const repository = fixture(attempts)
			const beforeB = repository.intents.get('b'); const beforeC = repository.intents.get('c')
			const calls: string[] = []; const facts: SideEffectIntent[] = []; const pauses: (string | undefined)[] = []
			const results = await run(repository, {
				newsletter: { isPaused: async () => false, pause: async value => { pauses.push(value) } },
				subscribe: async () => {
					calls.push('subscribe')
					if (calls.length === 2) throw Object.assign(new Error('known refusal'), { status: 429, retryAfter: '180' })
					return 'added'
				}, dispatch: intent => { facts.push(intent) },
			})
			expect(calls).toHaveLength(2); expect(pauses).toEqual(['180'])
			expect(results.map(result => result.status)).toEqual(['completed', 'newsletter-paused'])
			expect(repository.intents.get('b')).toEqual(beforeB); expect(repository.intents.get('c')).toEqual(beforeC)
			expect(facts.map(fact => fact.status)).toEqual(['completed'])
		},
	)
	it('fresh run/reexecution honors active pause before row selection or provider; expiry permits', async () => {
		const repository = fixture(); let clock = 0; let expires = 0; let calls = 0
		const newsletter = { isPaused: async () => expires > clock, pause: async () => { expires = clock + 120000 } }
		const subscribe = async () => { calls += 1; throw Object.assign(new Error('refused'), { status: 429 }) }
		expect((await run(repository, { newsletter, subscribe }))[0]?.status).toBe('newsletter-paused')
		expect(calls).toBe(1)
		expect(await run(repository, { newsletter, subscribe })).toEqual([])
		expect(calls).toBe(1)
		clock = 120000
		// Explicit boundary: absent saved step result, expiry permits old-run
		// reexecution too. TTL alone is not indefinite rest-of-run protection.
		await run(repository, { newsletter, subscribe }); expect(calls).toBe(2)
	})
	it('a pause arriving during work is checked immediately before each enrollment', async () => {
		const repository = fixture(); let paused = false; let calls = 0
		const results = await run(repository, {
			newsletter: { isPaused: async () => paused, pause: async () => {} },
			subscribe: async () => { calls += 1; paused = true; return 'added' },
		})
		expect(calls).toBe(1); expect(results.map(result => result.status)).toEqual(['completed', 'newsletter-paused'])
		expect(repository.intents.get('b')?.metadata.attempts).toBe(0)
	})
	it('marker read failure aborts without provider calls', async () => {
		const repository = fixture(); let calls = 0
		await expect(run(repository, {
			newsletter: { isPaused: async () => { throw new Error('storage unavailable') }, pause: async () => {} },
			subscribe: async () => { calls += 1 },
		})).rejects.toThrow('storage unavailable')
		expect(calls).toBe(0); expect(repository.intents.get('a')?.metadata.attempts).toBe(0)
	})
	it('marker write failure propagates once, with no intent/attempt mutation or later calls', async () => {
		const repository = fixture(6); let calls = 0; let writes = 0; let facts = 0
		await expect(run(repository, {
			newsletter: { isPaused: async () => false, pause: async () => { writes += 1; throw new Error('storage unavailable') } },
			subscribe: async () => { calls += 1; throw Object.assign(new Error('refusal'), { status: 429 }) },
			dispatch: () => { facts += 1 },
		})).rejects.toThrow('storage unavailable')
		expect([calls, writes, facts]).toEqual([1, 1, 0])
		expect(repository.intents.get('a')).toMatchObject({ status: 'pending', metadata: { attempts: 6 } })
	})
	it('legacy newsletter mode still retries/counts429 and continues the batch', async () => {
		const repository = fixture(); let calls = 0
		const results = await run(repository, { subscribe: async () => { calls += 1; throw Object.assign(new Error('429'), { status: 429 }) } })
		expect(calls).toBe(3); expect(results.map(result => result.status)).toEqual(['retry', 'retry', 'retry'])
		expect(repository.intents.get('a')?.metadata.attempts).toBe(1)
	})
	it('nonnewsletter callers ignore even an injected newsletter port', async () => {
		const repository = fixture(); let pauseReads = 0
		for (const [id, intent] of repository.intents) repository.intents.set(id, { ...intent, type: 'send-evergreen-email' })
		const results = await run(repository, {
			type: 'send-evergreen-email', newsletter: { isPaused: async () => { pauseReads += 1; return true }, pause: async () => {} },
			subscribe: async () => { throw Object.assign(new Error('429'), { status: 429 }) },
		})
		expect(pauseReads).toBe(0); expect(results.map(result => result.status)).toEqual(['retry', 'retry', 'retry'])
	})
	it.each([503, 422, undefined])('opt-in preserves existing non429 error semantics for %s', async status => {
		const repository = fixture(); let pauses = 0
		const results = await run(repository, {
			newsletter: { isPaused: async () => false, pause: async () => { pauses += 1 } },
			subscribe: async () => { throw Object.assign(new Error('unchanged failure'), { status }) },
		})
		expect(pauses).toBe(0)
		expect(results.map(result => result.status)).toEqual(Array(3).fill(status === 422 ? 'failed' : 'retry'))
		expect(repository.intents.get('a')?.metadata.attempts).toBe(1)
	})
})
