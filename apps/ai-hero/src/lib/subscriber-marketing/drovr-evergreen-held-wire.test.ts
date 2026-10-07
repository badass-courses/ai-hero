import { describe, expect, it, vi } from 'vitest'
import { acceptDrovrIntent, type DrovrIntent } from './drovr-executor'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import type { SideEffectIntent } from './types'

const now = '2026-10-07T00:00:00.000Z'
async function fixture(kind: 'email.send' | 'list.subscribe') {
	const repository = new InMemorySubscriberMarketingRepository()
	repository.contacts.set('contact-1', {
		id: 'contact-1',
		email: 'reader@example.test',
		name: null,
		lifecycle: 'nurture-ready',
		isProvisional: false,
		createdAt: now,
		updatedAt: now,
	})
	const request: DrovrIntent = {
		tenantId: 'org-aihero',
		contactId: 'contact-1',
		journeyId: 'crash-course-evergreen-offer',
		kind,
		idempotencyKey: `wire-test:${kind}`,
		dueAt: now,
		payload:
			kind === 'list.subscribe'
				? { list: 'shadow-newsletter' }
				: { messageId: 'bridge_can_engineer_v1' },
	}
	const accept = () =>
		acceptDrovrIntent({
			repository,
			intent: request,
			now,
			evergreen: { enabled: true },
		})
	const accepted = await accept()
	if (accepted.status !== 'accepted')
		throw new Error(`Expected accepted fixture, got ${accepted.status}`)
	const row = repository.sideEffectIntents.get(accepted.intentId)!
	return { repository, accept, row }
}

describe.each(['email.send', 'list.subscribe'] as const)(
	'evergreen held wire reply: %s',
	(kind) => {
		it('answers a persisted old-newsletter exit hold as the exact named block without mutations', async () => {
			const { repository, accept, row } = await fixture(kind)
			const held = {
				...row,
				status: 'held-for-exit' as const,
				reviewReasons: ['old-newsletter-exit-unconfirmed'],
			}
			repository.sideEffectIntents.set(row.id, held)
			const writes = vi.spyOn(repository, 'updateSideEffectIntent')
			expect(await accept()).toEqual({
				status: 'blocked',
				intentId: row.id,
				reviewReasons: [
					'evergreen-held-for-exit: old-newsletter-exit-unconfirmed',
				],
			})
			expect(repository.sideEffectIntents.get(row.id)).toEqual(held)
			expect(writes).not.toHaveBeenCalled()
		})
		it.each([
			'pending',
			'sending',
			'held-for-exit',
		] satisfies SideEffectIntent['status'][])(
			'preserves %s acceptance with any other reason',
			async (status) => {
				const { repository, accept, row } = await fixture(kind)
				repository.sideEffectIntents.set(row.id, {
					...row,
					status,
					reviewReasons: ['some-other-hold'],
				})
				expect(await accept()).toEqual({
					status: 'accepted',
					intentId: row.id,
					idempotencyKey: row.idempotencyKey,
					created: false,
				})
			},
		)
		it('does not map the reason without the held-for-exit status', async () => {
			const { repository, accept, row } = await fixture(kind)
			repository.sideEffectIntents.set(row.id, {
				...row,
				reviewReasons: ['old-newsletter-exit-unconfirmed'],
			})
			expect(await accept()).toMatchObject({
				status: 'accepted',
				created: false,
			})
		})
		it('maps a create-race winner held for the same exit to blocked too', async () => {
			const { repository, accept, row } = await fixture(kind)
			repository.sideEffectIntents.delete(row.id)
			vi.spyOn(repository, 'createSideEffectIntent').mockImplementationOnce(
				(input) => {
					repository.sideEffectIntents.set('race-winner', {
						...input,
						id: 'race-winner',
						status: 'held-for-exit',
						reviewReasons: ['old-newsletter-exit-unconfirmed'],
					})
					throw new Error('synthetic unique-key race')
				},
			)
			expect(await accept()).toEqual({
				status: 'blocked',
				intentId: 'race-winner',
				reviewReasons: [
					'evergreen-held-for-exit: old-newsletter-exit-unconfirmed',
				],
			})
			expect(repository.sideEffectIntents.size).toBe(1)
		})
	},
)
