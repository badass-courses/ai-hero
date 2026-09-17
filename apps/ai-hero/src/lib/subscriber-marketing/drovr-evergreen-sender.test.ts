import { describe, expect, it } from 'vitest'

import {
	EVERGREEN_SEND_MAX_ATTEMPTS,
	executePendingEvergreenSends,
	type EvergreenSenderRepository,
} from './drovr-evergreen-sender'
import type { ContactRecord, SideEffectIntent } from './types'

const now = '2026-09-17T16:00:00.000Z'

class FakeRepository implements EvergreenSenderRepository {
	contacts = new Map<string, ContactRecord>()
	intents = new Map<string, SideEffectIntent>()
	findContactById(id: string) {
		return this.contacts.get(id)
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
			dispatch: () => {},
		})
		expect(results[0]).toMatchObject({ status: 'failed', intentId: 'row-1' })
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
		expect(subscribes).toMatchObject([
			{
				listId: '2625552',
				user: { email: 'learner@example.com', name: 'Learner' },
			},
		])
		expect(repository.intents.get('row-1')?.status).toBe('pending')
		expect(repository.intents.get('row-2')?.status).toBe('completed')
	})
})
