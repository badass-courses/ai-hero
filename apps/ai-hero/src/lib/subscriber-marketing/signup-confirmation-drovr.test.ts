import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	confirmationReconcilerOffKitEnabled,
	legacyKitConfirmationSubscribers,
	reconcileDrovrConfirmations,
	type DrovrConfirmationSubject,
} from './signup-confirmation-drovr'
import type { DrovrListState } from './drovr-list-state'
import { emailEquivalenceKey } from './contact-email-equivalence'

const window = { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }
const subject: DrovrConfirmationSubject = {
	contactId: 'doi-contact',
	emailKey: emailEquivalenceKey('learner@example.test'),
	requestedAt: '2026-10-29T00:00:00Z',
}
function state(status: DrovrListState['state']): DrovrListState {
	return {
		contactId: subject.contactId,
		kitSubscriberId: null,
		tenantId: 'org-aihero',
		scope: 'all',
		state: status,
		forms:
			status === 'unknown'
				? []
				: [
						{
							formId: 'skills-newsletter',
							state: status === 'confirmed' ? 'confirmed' : 'unconfirmed',
						},
					],
		stops: [],
		unknownReason: status === 'unknown' ? 'no-consent-evidence' : null,
	}
}
afterEach(() => {
	vi.unstubAllGlobals()
})

describe('DOI confirmation ownership, with Kit unreachable', () => {
	it('is default off, and only literal true enables it', () => {
		for (const raw of [undefined, '', 'false', '1', 'TRUE']) {
			expect(
				confirmationReconcilerOffKitEnabled({
					AIH_CONFIRM_RECONCILER_OFF_KIT_ENABLED: raw,
				}),
			).toBe(false)
		}
		expect(
			confirmationReconcilerOffKitEnabled({
				AIH_CONFIRM_RECONCILER_OFF_KIT_ENABLED: 'true',
			}),
		).toBe(true)
	})
	it.each(['confirmed', 'unconfirmed', 'stopped', 'unknown'] as const)(
		'%s stays under drovr ownership, with no Kit-id enrolment replay',
		async (status) => {
			const kit = vi.fn(() => {
				throw new Error('Kit unreachable')
			})
			vi.stubGlobal('fetch', kit)
			const read = vi.fn(async () => state(status))
			const receipt = await reconcileDrovrConfirmations({
				subjects: [subject],
				window,
				read,
			})
			expect(receipt.counts[status]).toBe(1)
			expect(receipt.owner).toBe('drovr-confirm-fold-and-outbox')
			expect(read).toHaveBeenCalledWith('doi-contact')
			expect(kit).not.toHaveBeenCalled()
		},
	)
	it.each([
		null,
		'throw',
		'wrong-contact',
		'other-form',
		'course-stop',
	] as const)(
		'handles %s without confirming or dropping the signup',
		async (failure) => {
			const read = async () => {
				if (failure === 'throw') throw new Error('drovr unavailable')
				if (failure === null) return null
				const answer = state('confirmed')
				if (failure === 'wrong-contact') answer.contactId = 'other'
				if (failure === 'other-form')
					answer.forms = [{ formId: 'unrelated', state: 'confirmed' }]
				if (failure === 'course-stop')
					answer.stops = [
						{
							scope: 'value-path-skills-course',
							reason: 'unsubscribed',
							createdAt: window.to,
						},
					]
				return answer
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await reconcileDrovrConfirmations({
					subjects: [subject],
					window,
					read,
				})
				expect(result.counts.confirmed).toBe(0)
				expect(
					result.counts[failure === 'course-stop' ? 'stopped' : 'unknown'],
				).toBe(1)
			}
		},
	)
	it('filters persisted DOI addresses before legacy confirmation/tag/sequence decisions, independent of Kit id', () => {
		const subscribers = [
			{ email: 'LEARNER@example.test' },
			{ email: 'legacy@example.test' },
		]
		expect(legacyKitConfirmationSubscribers(subscribers, [subject])).toEqual([
			subscribers[1],
		])
	})
	it('daily rotation advances one page per day rather than skipping 96 pages', async () => {
		const subjects = Array.from({ length: 1000 }, (_, i) => ({
			...subject,
			contactId: String(i),
		}))
		const seen = new Set<string>()
		for (let day = 0; day < 20; day++) {
			await reconcileDrovrConfirmations({
				subjects,
				window: {
					...window,
					to: new Date(Date.parse(window.to) + day * 86_400_000).toISOString(),
				},
				runIndex: day,
				read: async (id) => {
					seen.add(id)
					return null
				},
			})
		}
		expect(seen.size).toBe(1000)
	})
	it('bounds reads and rotates so a standing pending page cannot starve later subjects', async () => {
		const subjects = Array.from({ length: 110 }, (_, i) => ({
			...subject,
			contactId: String(i),
		}))
		const seen = new Set<string>()
		for (let poll = 0; poll < 3; poll++) {
			const result = await reconcileDrovrConfirmations({
				subjects,
				window: {
					...window,
					to: new Date(Date.parse(window.to) + poll * 900_000).toISOString(),
				},
				read: async (id) => {
					seen.add(id)
					return null
				},
			})
			expect(result.counts.selected).toBe(50)
			expect(result.counts.deferred).toBe(60)
		}
		expect(seen.size).toBe(110)
	})
})
