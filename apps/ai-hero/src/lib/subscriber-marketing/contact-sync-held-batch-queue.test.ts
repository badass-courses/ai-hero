import { describe, expect, it, vi } from 'vitest'
import { queueCappedReplay } from './contact-sync-replay-queue'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const now = Date.parse('2032-01-01T00:00:00.000Z')
function row(): DrovrOutboxRow {
	const event: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-queue-contact',
		journeyId: 'contact-directory',
		type: 'contact.offer.issued',
		occurredAt: new Date(now).toISOString(),
		idempotencyKey: 'synthetic-held-offer',
		payload: {
			profileVersion: 3,
			journeyId: 'crash-course-evergreen-offer',
			variables: {},
		},
	}
	const entry = outboxEntryForEvent(event, 'live')
	return {
		...entry,
		id: 'synthetic-queue-row',
		target: 'synthetic-target',
		dedupeKey: drovrOutboxDedupeKey('synthetic-target', entry),
		status: 'pending',
		attempts: 999,
		lastStatus: 503,
		lastError: 'synthetic original HTTP failure',
		firstFailedAt: new Date(now).toISOString(),
		nextAttemptAt: new Date(now).toISOString(),
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: new Date(now).toISOString(),
	}
}

describe('released coordinator publication uses existing queue ownership', () => {
	it('claims a native live-origin row before the decoded coordinator command and never posts/publishes its raw body', async () => {
		const input = row()
		const before = JSON.stringify(input)
		let publicationId: string | undefined
		const lease = vi.fn(
			async (_until: string, expected: string | undefined, claim: string) => {
				expect(expected).toBeUndefined()
				publicationId = claim
				return true
			},
		)
		const normal = vi.fn(async () => {
			throw new Error('raw envelope must not publish')
		})
		const continuation = vi.fn(async () => {
			expect(publicationId).toMatch(/^[a-f0-9-]{36}$/)
			return { ids: ['synthetic-command'] }
		})
		const abort = vi.fn(async () => {})
		expect(
			await queueCappedReplay(input, normal, now, lease, abort, continuation),
		).toMatchObject({ kind: 'queued', phase: 'published', publicationId })
		expect(lease).toHaveBeenCalledOnce()
		expect(continuation).toHaveBeenCalledOnce()
		expect(normal).not.toHaveBeenCalled()
		expect(abort).not.toHaveBeenCalled()
		expect(JSON.stringify(input)).toBe(before)
	})
	it.each([
		{ queuePublicationId: 'synthetic-abandoned-claim' },
		{ queueMetadataInvalid: true },
		{ queueHandoffs: 8 },
	])(
		'a coordinator override cannot bypass retained effort/publication proof: %j',
		(patch) => {
			return (async () => {
				const lease = vi.fn(async () => true)
				const continuation = vi.fn(async () => {})
				expect(
					await queueCappedReplay(
						{ ...row(), ...patch },
						vi.fn(),
						now,
						lease,
						vi.fn(),
						continuation,
					),
				).toMatchObject({ kind: 'held' })
				expect(lease).not.toHaveBeenCalled()
				expect(continuation).not.toHaveBeenCalled()
			})()
		},
	)
	it('a failed coordinator broker call shortens only its matching claim, never falling back to a raw event', async () => {
		const input = row()
		const before = JSON.stringify(input)
		const lease = vi.fn(async () => true)
		const normal = vi.fn()
		const abort = vi.fn()
		const answer = await queueCappedReplay(
			input,
			normal,
			now,
			lease,
			abort,
			async () => {
				throw new Error('synthetic broker outage')
			},
		)
		expect(answer).toMatchObject({
			kind: 'queued',
			phase: 'deferred',
			nextAttemptAt: new Date(now + 60_000).toISOString(),
		})
		expect(lease).toHaveBeenCalledTimes(2)
		expect(normal).not.toHaveBeenCalled()
		expect(abort).not.toHaveBeenCalled()
		expect(JSON.stringify(input)).toBe(before)
	})
	it('a stale queue lease cannot publish an explicitly released coordinator either', async () => {
		const continuation = vi.fn(async () => {})
		expect(
			await queueCappedReplay(
				row(),
				vi.fn(),
				now,
				async () => false,
				vi.fn(),
				continuation,
			),
		).toEqual({ kind: 'queued', phase: 'stale' })
		expect(continuation).not.toHaveBeenCalled()
	})
})
