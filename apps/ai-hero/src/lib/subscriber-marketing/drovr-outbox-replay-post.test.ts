import { describe, expect, it, vi } from 'vitest'

import {
	DrovrSignupRefusedError,
	DrovrSignupRetryableError,
} from './drovr-doi-signup'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	outboxEntryForSignup,
	type DrovrOutboxRow,
} from './drovr-outbox'
import {
	DROVR_OUTBOX_POST_TIMEOUT_MS,
	postDrovrOutboxRow,
	type DrovrOutboxPostPorts,
} from './drovr-outbox-replay-post'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const unsubscribe: DrovrShadowEvent = {
	tenantId: 'org-aihero-shadow' as never,
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	type: 'contact.unsubscribed',
	occurredAt: '2026-09-30T11:00:00.000Z',
	idempotencyKey: 'aihero:stop:1',
}
const authorityCopy = {
	...unsubscribe,
	tenantId: 'org-aihero' as const,
	idempotencyKey: `owner:${unsubscribe.idempotencyKey}`,
}

const asRow = (
	entry: ReturnType<typeof outboxEntryForEvent>,
): DrovrOutboxRow => ({
	...entry,
	id: 'row-1',
	dedupeKey: drovrOutboxDedupeKey('t', entry),
	target: 't',
	status: 'pending',
	attempts: 0,
	lastStatus: null,
	lastError: null,
	firstFailedAt: '2026-09-30T11:00:00.000Z',
	nextAttemptAt: '2026-09-30T11:00:00.000Z',
	lastAttemptAt: null,
	deliveredAt: null,
	releasedAt: null,
	createdAt: '2026-09-30T11:00:00.000Z',
})

// As on prod: only the authority tenant has a key. The retired shadow
// tenant has none, which a blanket stub used to hide.
const ports = (
	overrides: Partial<DrovrOutboxPostPorts> = {},
): DrovrOutboxPostPorts => ({
	ingestUrl: 'https://drovr.example/events',
	apiKeyFor: (tenantId) =>
		tenantId === 'org-aihero' ? 'authority-key' : undefined,
	deliver: vi.fn(async () => ({ status: 'accepted' as const })),
	fanOut: vi.fn(async (events) => [...events, authorityCopy]),
	isNeverBornOwnerStop: () => false,
	...overrides,
})

const shadowRow = () =>
	asRow(outboxEntryForEvent(unsubscribe, 'onFailure', { needsFanOut: true }))

describe('postDrovrOutboxRow', () => {
	it('re-posts the exact body under its key, with a 10 second deadline', async () => {
		const p = ports()
		const outcome = await postDrovrOutboxRow(
			asRow(outboxEntryForEvent(authorityCopy, 'live')),
			p,
		)
		expect(outcome).toEqual({ kind: 'delivered', httpStatus: 200 })
		expect(p.deliver).toHaveBeenCalledWith({
			event: authorityCopy,
			config: {
				ingestUrl: 'https://drovr.example/events',
				apiKey: 'authority-key',
			},
			timeoutMs: DROVR_OUTBOX_POST_TIMEOUT_MS,
		})
		expect(p.fanOut).not.toHaveBeenCalled()
	})

	it("fans a shadow row out and posts only its owner copy, with prod's keys", async () => {
		const p = ports()
		expect(await postDrovrOutboxRow(shadowRow(), p)).toEqual({
			kind: 'delivered',
			httpStatus: 200,
		})
		expect(p.fanOut).toHaveBeenCalledWith([unsubscribe])
		expect(
			vi
				.mocked(p.deliver)
				.mock.calls.map(([args]) => args.event.idempotencyKey),
		).toEqual(['owner:aihero:stop:1'])
	})

	it('settles a shadow row with no owner copy owed: nothing deliverable, nothing posted', async () => {
		const p = ports({ fanOut: vi.fn(async (events) => [...events]) })
		expect(await postDrovrOutboxRow(shadowRow(), p)).toEqual({
			kind: 'settled',
			detail: 'nothing-deliverable',
		})
		expect(p.deliver).not.toHaveBeenCalled()
	})

	it.each([500, 503])(
		'answers a transient failure with drovr status and Retry-After on a %i',
		async (httpStatus) => {
			const outcome = await postDrovrOutboxRow(
				asRow(outboxEntryForEvent(authorityCopy, 'live')),
				ports({
					deliver: async () => ({
						status: 'failed',
						httpStatus,
						reason: `drovr answered ${httpStatus}`,
						retryAfterMs: 30_000,
					}),
				}),
			)
			expect(outcome).toEqual({
				kind: 'failed',
				transient: true,
				httpStatus,
				reason: `drovr answered ${httpStatus}`,
				retryAfterMs: 30_000,
			})
		},
	)

	it('answers a timeout or no answer as transient', async () => {
		expect(
			await postDrovrOutboxRow(
				asRow(outboxEntryForEvent(authorityCopy, 'live')),
				ports({
					deliver: async () => ({ status: 'failed', reason: 'aborted' }),
				}),
			),
		).toEqual({ kind: 'failed', transient: true, reason: 'aborted' })
	})

	it('answers a 409 event-not-live and a missing key as not transient', async () => {
		expect(
			await postDrovrOutboxRow(
				asRow(outboxEntryForEvent(authorityCopy, 'live')),
				ports({
					deliver: async () => ({
						status: 'failed',
						httpStatus: 409,
						reason:
							'drovr does not take this event type yet (409 event-not-live)',
					}),
				}),
			),
		).toMatchObject({ kind: 'failed', transient: false, httpStatus: 409 })
		expect(
			await postDrovrOutboxRow(
				asRow(outboxEntryForEvent(authorityCopy, 'live')),
				ports({ apiKeyFor: () => undefined }),
			),
		).toMatchObject({ kind: 'failed', transient: false })
	})

	it('answers rejected on a 4xx for the row itself', async () => {
		expect(
			await postDrovrOutboxRow(
				asRow(outboxEntryForEvent(authorityCopy, 'live')),
				ports({
					deliver: async () => ({
						status: 'rejected',
						httpStatus: 422,
						problem: { type: 'invalid' },
					}),
				}),
			),
		).toEqual({
			kind: 'rejected',
			httpStatus: 422,
			detail: { type: 'invalid' },
			idempotencyKey: authorityCopy.idempotencyKey,
		})
	})

	it('answers rejected, naming the copy, when drovr refuses an owner copy', async () => {
		expect(
			await postDrovrOutboxRow(
				shadowRow(),
				ports({
					deliver: async () => ({
						status: 'rejected',
						httpStatus: 422,
						problem: { type: 'invalid' },
					}),
				}),
			),
		).toEqual({
			kind: 'rejected',
			httpStatus: 422,
			detail: { type: 'invalid' },
			idempotencyKey: 'owner:aihero:stop:1',
		})
	})

	it('settles an owner stop for a contact never born there, on a fanned row too', async () => {
		expect(
			await postDrovrOutboxRow(
				shadowRow(),
				ports({
					deliver: async () => ({
						status: 'rejected',
						httpStatus: 409,
						problem: { type: 'contact-never-born' },
					}),
					isNeverBornOwnerStop: () => true,
				}),
			),
		).toEqual({
			kind: 'settled',
			httpStatus: 409,
			detail: 'owner-stop-never-born',
		})
	})

	it('is delivered when one copy lands and another is a never-born stop', async () => {
		const second = {
			...authorityCopy,
			journeyId: 'crash-course-evergreen-offer' as const,
			idempotencyKey: 'owner:aihero:stop:1:evergreen',
		}
		let call = 0
		expect(
			await postDrovrOutboxRow(
				shadowRow(),
				ports({
					fanOut: vi.fn(async (events) => [
						...events,
						authorityCopy,
						second as never,
					]),
					deliver: async () =>
						call++ === 0
							? { status: 'accepted' as const }
							: {
									status: 'rejected' as const,
									httpStatus: 409,
									problem: { type: 'contact-never-born' },
								},
					isNeverBornOwnerStop: (event) =>
						event.idempotencyKey === second.idempotencyKey,
				}),
			),
		).toEqual({ kind: 'delivered', httpStatus: 200 })
	})

	describe('signups', () => {
		const request = {
			tenantId: 'org-aihero' as const,
			contactId: 'contact-1',
			formId: 'form-1',
			occurredAt: '2026-09-30T11:00:00.000Z',
			submissionId: 'submission-1',
			source: { page: '/' },
		}
		const row = asRow(outboxEntryForSignup(request) as never)

		it('re-posts the signup and answers delivered', async () => {
			const post = vi.fn(async () => 'awaiting-confirmation' as const)
			expect(
				await postDrovrOutboxRow(row, ports({ signup: { post } })),
			).toEqual({
				kind: 'delivered',
				httpStatus: 200,
			})
			expect(post).toHaveBeenCalledWith(request)
		})

		it.each([500, 503])('answers failed on a %i', async (httpStatus) => {
			const post = vi.fn(async () => {
				throw new DrovrSignupRetryableError(
					`HTTP ${httpStatus}`,
					httpStatus,
					20_000,
				)
			})
			expect(
				await postDrovrOutboxRow(row, ports({ signup: { post } })),
			).toEqual({
				kind: 'failed',
				transient: true,
				reason: `drovr signup not recorded yet: HTTP ${httpStatus}`,
				httpStatus,
				retryAfterMs: 20_000,
			})
		})

		it('answers rejected on a refusal', async () => {
			const post = vi.fn(async () => {
				throw new DrovrSignupRefusedError(422, 'invalid')
			})
			expect(
				await postDrovrOutboxRow(row, ports({ signup: { post } })),
			).toMatchObject({ kind: 'rejected', httpStatus: 422 })
		})
	})
})
