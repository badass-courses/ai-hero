import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findContactEventsByType: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('./drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {
		findContactEventsByType = mocks.findContactEventsByType
	},
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import {
	resolveDoiAnswerForwardContactIds,
	resolveOwnedContactIds,
	type DoiAnswerForwardReads,
} from './drovr-ownership-live'

/** A Kit stop about contact c1: an owner fan-out candidate. */
const kitStop = (contactId = 'c1') =>
	({
		tenantId: 'org-aihero-shadow',
		contactId,
		journeyId: 'value-path-skills-course',
		type: 'contact.unsubscribed',
		occurredAt: '2026-09-26T05:00:00.000Z',
		idempotencyKey: `stop:${contactId}`,
	}) as never

describe('resolveOwnedContactIds', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findContactEventsByType.mockResolvedValue([])
	})

	it('throws when the ownership read fails, so a durable step retries instead of dropping the stop', async () => {
		mocks.findContactEventsByType.mockRejectedValue(
			new Error('Vitess: connection reset'),
		)

		await expect(resolveOwnedContactIds([kitStop()])).rejects.toThrow(
			'Vitess: connection reset',
		)
		expect(mocks.log.error).toHaveBeenCalledWith('drovr.owner.resolve_failed', {
			contacts: 1,
			error: 'Vitess: connection reset',
		})
	})

	it('answers a real empty result as [] (candidates, none owned by drovr)', async () => {
		await expect(resolveOwnedContactIds([kitStop()])).resolves.toEqual([])
		expect(mocks.findContactEventsByType).toHaveBeenCalledTimes(1)
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('answers [] without a read when no event is an owner fan-out candidate', async () => {
		const shadowBirth = {
			...(kitStop() as object),
			type: 'contact.created',
		} as never
		await expect(resolveOwnedContactIds([shadowBirth])).resolves.toEqual([])
		expect(mocks.findContactEventsByType).not.toHaveBeenCalled()
	})

	it('returns the contacts drovr owns', async () => {
		mocks.findContactEventsByType.mockResolvedValue([
			{ providerEventId: 'drovr-owner:c1:value-path-skills-course' },
		])
		await expect(resolveOwnedContactIds([kitStop()])).resolves.toEqual(['c1'])
	})
})

describe('resolveDoiAnswerForwardContactIds', () => {
	const since = '2026-11-10T03:00:00.000Z'
	const lesson = 'ai-hero-skills-workflow.email-0'
	const answer = (contactId: string, emailResourceId = lesson) =>
		({
			...(kitStop(contactId) as object),
			type: 'value-path.answer-selected',
			idempotencyKey: `answer:${contactId}:${emailResourceId}`,
			payload: { emailResourceId },
		}) as never
	const readsFor = (
		doi: Record<string, string[]>,
		anchors: Record<string, string[]>,
	) => {
		const reads = {
			doiRequestedAt: vi.fn(async (contactId: string) => doi[contactId] ?? []),
			anchoredEmailResourceIds: vi.fn(
				async (contactId: string) => new Set(anchors[contactId] ?? []),
			),
		}
		return reads satisfies DoiAnswerForwardReads
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('reads nothing for a batch without a skills-course answer', async () => {
		const reads = readsFor({}, {})
		await expect(
			resolveDoiAnswerForwardContactIds([kitStop()], { since, reads }),
		).resolves.toEqual([])
		expect(reads.doiRequestedAt).not.toHaveBeenCalled()
	})

	it('picks only new DOI learners with an anchor for the lesson they answered', async () => {
		const reads = readsFor(
			{
				new: ['2026-11-10T04:00:00.000Z'],
				old: ['2026-11-09T20:00:00.000Z'],
				unanchored: ['2026-11-10T04:00:00.000Z'],
			},
			{ new: [lesson], old: [lesson] },
		)
		await expect(
			resolveDoiAnswerForwardContactIds(
				[answer('new'), answer('old'), answer('unanchored'), answer('no-doi')],
				{ since, reads },
			),
		).resolves.toEqual(['new'])
		// No DOI record: the anchor is never read.
		expect(reads.anchoredEmailResourceIds).not.toHaveBeenCalledWith(
			'no-doi',
			expect.anything(),
		)
	})

	it('answers [] and logs at error when a read fails, never throwing into delivery', async () => {
		const reads = readsFor({}, {})
		reads.doiRequestedAt.mockRejectedValue(new Error('Vitess: connection reset'))
		await expect(
			resolveDoiAnswerForwardContactIds([answer('new')], { since, reads }),
		).resolves.toEqual([])
		expect(mocks.log.error).toHaveBeenCalledWith(
			'drovr.doi_answer_forward.resolve_failed',
			{ contacts: 1, error: 'Vitess: connection reset' },
		)
	})
})
