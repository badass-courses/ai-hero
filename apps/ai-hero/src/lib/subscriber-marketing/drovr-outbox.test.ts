import { describe, expect, it, vi } from 'vitest'

import {
	captureDrovrOutbox,
	DROVR_OUTBOX_BEHIND_STOP_NOTE,
	DROVR_OUTBOX_CAPTURE_TRIES,
	DROVR_OUTBOX_DELIVERED_RETENTION_MS,
	DROVR_OUTBOX_HELD_BIRTH_WAIT_MS,
	DROVR_SEND_BACKOFF_MS,
	DROVR_SEND_RETRIES,
	drovrOutboxDedupeKey,
	drovrOutboxTarget,
	DrovrOutboxUnavailableError,
	drovrReplayDelayMs,
	drovrRetryDelayMs,
	holdDrovrStops,
	isOutboxBirth,
	isOutboxStop,
	outboxEntryForEvent,
	outboxEntryForSignup,
	parseRetryAfterMs,
	replayOrder,
	runDrovrOutboxReplay,
	settleDrovrOutbox,
	type DrovrOutboxDepth,
	type DrovrOutboxPostOutcome,
	type DrovrOutboxRow,
	type DrovrOutboxStore,
} from './drovr-outbox'
import { postDrovrOutboxRow } from './drovr-outbox-replay-post'
import {
	deliverDrovrShadowEvent,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

const PROD = 'production'
const PREVIEW = 'preview:worker/x'

/** The table's contract in memory: dedupeKey is unique, insert ignores. */
function memoryStore(initial: DrovrOutboxRow[] = []) {
	const rows = new Map(initial.map((row) => [row.id, { ...row }]))
	const store: DrovrOutboxStore = {
		async insertIgnore(inserted) {
			for (const row of inserted)
				if (![...rows.values()].some((r) => r.dedupeKey === row.dedupeKey))
					rows.set(row.id, { ...row })
		},
		async due({ target, now, limit }) {
			return [...rows.values()]
				.filter(
					(row) =>
						row.status === 'pending' &&
						row.target === target &&
						row.nextAttemptAt <= now,
				)
				.sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
				.slice(0, limit)
				.map((row) => ({ ...row }))
		},
		async openGates({ target, contactIds }) {
			return [...rows.values()]
				.filter(
					(row) =>
						row.target === target &&
						contactIds.includes(row.contactId) &&
						(((row.status === 'pending' || row.status === 'held') &&
							(row.eventType === 'contact.created' ||
								row.endpoint === 'signups')) ||
							(['pending', 'held', 'rejected'].includes(row.status) &&
								isOutboxStop(row))),
				)
				.map(
					({
						id,
						contactId,
						journeyId,
						endpoint,
						eventType,
						status,
						nextAttemptAt,
						occurredAt,
					}) => ({
						id,
						contactId,
						journeyId,
						endpoint,
						eventType,
						status,
						nextAttemptAt,
						occurredAt,
					}),
				)
		},
		async update(id, patch) {
			rows.set(id, { ...rows.get(id)!, ...patch })
		},
		async depth(target): Promise<DrovrOutboxDepth> {
			const mine = [...rows.values()].filter((row) => row.target === target)
			const pending = mine.filter((row) => row.status === 'pending')
			return {
				pending: pending.length,
				oldestPendingFailedAt:
					pending.map((row) => row.firstFailedAt).sort()[0] ?? null,
				held: mine.filter((row) => row.status === 'held').length,
				rejected: mine.filter((row) => row.status === 'rejected').length,
				oldestOpenStopFailedAt:
					mine
						.filter(
							(row) =>
								(row.status === 'pending' || row.status === 'rejected') &&
								row.source !== 'contactSync' &&
								isOutboxStop(row),
						)
						.map((row) => row.firstFailedAt)
						.sort()[0] ?? null,
				oldestDeferredStopFailedAt:
					mine
						.filter(
							(row) =>
								row.status === 'pending' &&
								row.source === 'contactSync' &&
								isOutboxStop(row),
						)
						.map((row) => row.firstFailedAt)
						.sort()[0] ?? null,
				heldStops: mine.filter(
					(row) => row.status === 'held' && isOutboxStop(row),
				).length,
				oldestHeldStopFailedAt:
					mine
						.filter((row) => row.status === 'held' && isOutboxStop(row))
						.map((row) => row.firstFailedAt)
						.sort()[0] ?? null,
			}
		},
		async holdPending({ target, dedupeKeys, at, note, httpStatus }) {
			let held = 0
			for (const [id, row] of rows)
				if (
					row.target === target &&
					row.status === 'pending' &&
					dedupeKeys.includes(row.dedupeKey)
				) {
					rows.set(id, {
						...row,
						status: 'held',
						lastAttemptAt: at,
						lastError: note,
						lastStatus: httpStatus,
					})
					held += 1
				}
			return held
		},
		async settlePending({ target, dedupeKeys, at, note }) {
			let settled = 0
			for (const [id, row] of rows)
				if (
					row.target === target &&
					row.status === 'pending' &&
					dedupeKeys.includes(row.dedupeKey)
				) {
					rows.set(id, {
						...row,
						status: 'delivered',
						deliveredAt: at,
						lastAttemptAt: at,
						lastError: note,
					})
					settled += 1
				}
			return settled
		},
		async pullForward({ target, contactIds, now }) {
			let moved = 0
			for (const [id, row] of rows)
				if (
					row.target === target &&
					contactIds.includes(row.contactId) &&
					row.status === 'pending' &&
					row.nextAttemptAt > now &&
					row.lastError === DROVR_OUTBOX_BEHIND_STOP_NOTE &&
					!isOutboxStop(row)
				) {
					rows.set(id, { ...row, nextAttemptAt: now })
					moved += 1
				}
			return moved
		},
		async deleteDeliveredBefore(before, limit) {
			let deleted = 0
			for (const [id, row] of rows)
				if (
					deleted < limit &&
					row.status === 'delivered' &&
					row.deliveredAt !== null &&
					row.deliveredAt <= before
				) {
					rows.delete(id)
					deleted += 1
				}
			return deleted
		},
	}
	return { store, rows }
}

const NOW = new Date('2026-09-30T12:00:00.000Z')
const minutesAgo = (minutes: number) =>
	new Date(NOW.getTime() - minutes * 60_000).toISOString()

const event = (
	idempotencyKey: string,
	overrides: Partial<DrovrShadowEvent> = {},
): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	type: 'value-path.answer-selected',
	occurredAt: minutesAgo(90),
	idempotencyKey,
	...overrides,
})

let serial = 0
function row(
	overrides: Partial<DrovrOutboxRow> & { body?: DrovrShadowEvent } = {},
): DrovrOutboxRow {
	const body = overrides.body ?? event(`key-${(serial += 1)}`)
	const entry = outboxEntryForEvent(body, 'live')
	const target = overrides.target ?? PROD
	return {
		...entry,
		id: `row-${(serial += 1)}`,
		dedupeKey: drovrOutboxDedupeKey(target, entry),
		target,
		status: 'pending',
		attempts: 0,
		lastStatus: 503,
		lastError: 'drovr answered 503',
		firstFailedAt: minutesAgo(10),
		nextAttemptAt: minutesAgo(1),
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: minutesAgo(10),
		...overrides,
	}
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function replay(
	store: DrovrOutboxStore,
	post: (row: DrovrOutboxRow) => Promise<DrovrOutboxPostOutcome>,
	extra: { now?: () => Date; budgetMs?: number; target?: string } = {},
) {
	const logger = log()
	return {
		logger,
		run: runDrovrOutboxReplay({
			store,
			target: extra.target ?? PROD,
			now: extra.now ?? (() => NOW),
			post,
			log: logger,
			...(extra.budgetMs === undefined ? {} : { budgetMs: extra.budgetMs }),
		}),
	}
}

describe('drovr outbox target', () => {
	it('is the Vercel environment, whatever drovr URL the deployment posts to', () => {
		expect(drovrOutboxTarget({ VERCEL_ENV: 'production' })).toBe(PROD)
		// The stage proof moves the ingest URL to a stub origin and back: the
		// target, and so the rows it can see, stay the same.
		expect(
			drovrOutboxTarget({
				VERCEL_ENV: 'production',
				DROVR_SHADOW_INGEST_URL: 'https://stub.example/events',
			} as never),
		).toBe(PROD)
	})

	it('scopes a preview to its branch, so no preview replays another one', () => {
		expect(
			drovrOutboxTarget({
				VERCEL_ENV: 'preview',
				VERCEL_GIT_COMMIT_REF: 'worker/x',
			}),
		).toBe(PREVIEW)
		expect(drovrOutboxTarget({})).toBe('development')
	})

	it('keys a row by target too: the same event on two targets is two rows', () => {
		const entry = outboxEntryForEvent(event('k'), 'live')
		expect(drovrOutboxDedupeKey(PROD, entry)).not.toBe(
			drovrOutboxDedupeKey(PREVIEW, entry),
		)
		expect(drovrOutboxDedupeKey(PROD, entry)).toBe(
			drovrOutboxDedupeKey(PROD, { ...entry }),
		)
		expect(drovrOutboxDedupeKey(PROD, entry)).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('drovr retry delays (must 4)', () => {
	it('outlasts a 60 minute drovr overload before the outbox takes over', () => {
		expect(DROVR_SEND_RETRIES).toBe(8)
		const budgetMs = Array.from({ length: DROVR_SEND_RETRIES }, (_, attempt) =>
			drovrRetryDelayMs(attempt),
		).reduce((sum, delay) => sum + delay, 0)
		expect(budgetMs).toBe(78.75 * 60_000)
		expect(budgetMs).toBeGreaterThan(60 * 60_000)
	})

	it('never lets a short Retry-After spend the budget early', () => {
		for (let attempt = 0; attempt < DROVR_SEND_RETRIES; attempt += 1)
			expect(drovrRetryDelayMs(attempt, 5_000)).toBe(
				DROVR_SEND_BACKOFF_MS[attempt],
			)
	})

	it('honours a longer Retry-After up to 10 minutes', () => {
		expect(drovrRetryDelayMs(0, 120_000)).toBe(120_000)
		expect(drovrRetryDelayMs(0, 3_600_000)).toBe(600_000)
		// The table's own 20 and 40 minute delays stay above the cap.
		expect(drovrRetryDelayMs(7, 600_000)).toBe(2_400_000)
	})

	it('backs a replay off exponentially to an hour, Retry-After capped at 15 minutes', () => {
		expect(drovrReplayDelayMs(1)).toBe(60_000)
		expect(drovrReplayDelayMs(3)).toBe(4 * 60_000)
		expect(drovrReplayDelayMs(20)).toBe(60 * 60_000)
		expect(drovrReplayDelayMs(1, 30 * 60_000)).toBe(15 * 60_000)
	})

	it('reads Retry-After as seconds or an HTTP date', () => {
		const now = Date.parse('2026-09-30T12:00:00.000Z')
		expect(parseRetryAfterMs('30', now)).toBe(30_000)
		expect(parseRetryAfterMs('Wed, 30 Sep 2026 12:02:00 GMT', now)).toBe(
			120_000,
		)
		expect(parseRetryAfterMs('soon', now)).toBeUndefined()
		expect(parseRetryAfterMs(null, now)).toBeUndefined()
	})
})

describe('captureDrovrOutbox', () => {
	it('keeps the exact body under its key, pending and due now', async () => {
		const { store, rows } = memoryStore()
		const body = event('owner:answer')
		const result = await captureDrovrOutbox({
			store,
			target: PROD,
			entries: [outboxEntryForEvent(body, 'live')],
			reason: new Error('drovr answered 503'),
			httpStatus: 503,
			now: NOW,
			log: log(),
		})
		expect(result).toEqual({ status: 'outboxed', count: 1 })
		const [kept] = [...rows.values()]
		expect(kept).toMatchObject({
			target: PROD,
			endpoint: 'events',
			idempotencyKey: 'owner:answer',
			body,
			status: 'pending',
			attempts: 0,
			lastStatus: 503,
			nextAttemptAt: NOW.toISOString(),
		})
	})

	it('keeps a stop captured on its first failure for after the retries: its next attempt is the one passed', async () => {
		const { store, rows } = memoryStore()
		const later = new Date(NOW.getTime() + 78.75 * 60_000)
		await captureDrovrOutbox({
			store,
			target: PROD,
			entries: [
				outboxEntryForEvent(
					event('owner:purchase', { type: 'purchase.recorded' }),
					'live',
				),
			],
			reason: new Error('drovr answered 503'),
			now: NOW,
			nextAttemptAt: later,
			log: log(),
		})
		expect([...rows.values()][0]).toMatchObject({
			firstFailedAt: NOW.toISOString(),
			nextAttemptAt: later.toISOString(),
		})
	})

	it('logs a settle that fails and returns 0: the send did land', async () => {
		const { store } = memoryStore()
		const logger = log()
		const settled = await settleDrovrOutbox({
			store: {
				...store,
				settlePending: async () => {
					throw new Error('Vitess: connection reset')
				},
			},
			target: PROD,
			entries: [outboxEntryForEvent(event('owner:purchase'), 'live')],
			note: 'delivered by an Inngest retry',
			now: NOW,
			log: logger,
		})
		expect(settled).toBe(0)
		expect(logger.error).toHaveBeenCalledWith(
			'drovr.outbox.settle_failed',
			expect.objectContaining({ idempotencyKeys: ['owner:purchase'] }),
		)
	})

	it('keeps one row per send however often it is captured', async () => {
		const { store, rows } = memoryStore()
		const entries = [outboxEntryForEvent(event('owner:answer'), 'live')]
		for (let i = 0; i < 3; i += 1)
			await captureDrovrOutbox({
				store,
				target: PROD,
				entries,
				reason: 'x',
				now: NOW,
				log: log(),
			})
		expect(rows.size).toBe(1)
	})

	it('answers unavailable, at error with the keys, before the table exists', async () => {
		const logger = log()
		const result = await captureDrovrOutbox({
			store: {
				...memoryStore().store,
				insertIgnore: async () => {
					throw new DrovrOutboxUnavailableError(
						new Error("Table 'AI_DrovrOutbox' doesn't exist"),
					)
				},
			},
			target: PROD,
			entries: [outboxEntryForEvent(event('owner:answer'), 'live')],
			reason: 'x',
			now: NOW,
			log: logger,
		})
		expect(result).toEqual({ status: 'unavailable' })
		expect(logger.error).toHaveBeenCalledWith(
			'drovr.outbox.unavailable',
			expect.objectContaining({ idempotencyKeys: ['owner:answer'] }),
		)
	})

	it('answers unconfigured without a target', async () => {
		expect(
			await captureDrovrOutbox({
				store: memoryStore().store,
				target: undefined,
				entries: [outboxEntryForEvent(event('k'), 'live')],
				reason: 'x',
				now: NOW,
				log: log(),
			}),
		).toEqual({ status: 'unconfigured' })
	})

	it('logs the keys first, retries a store error in place, then fails loudly with the keys', async () => {
		const logger = log()
		const insertIgnore = vi.fn(async () => {
			throw new Error('Vitess: connection reset')
		})
		const sleep = vi.fn(async () => undefined)
		await expect(
			captureDrovrOutbox({
				store: { ...memoryStore().store, insertIgnore },
				target: PROD,
				entries: [outboxEntryForEvent(event('k'), 'bulk')],
				reason: 'drovr answered 503',
				now: NOW,
				log: logger,
				sleep,
			}),
		).rejects.toThrow('Vitess')
		expect(insertIgnore).toHaveBeenCalledTimes(DROVR_OUTBOX_CAPTURE_TRIES)
		expect(logger.warn).toHaveBeenCalledWith(
			'drovr.outbox.capturing',
			expect.objectContaining({ count: 1, idempotencyKeys: ['k'] }),
		)
		expect(logger.warn.mock.invocationCallOrder[0]).toBeLessThan(
			insertIgnore.mock.invocationCallOrder[0]!,
		)
		expect(logger.error).toHaveBeenCalledWith(
			'drovr.outbox.capture_failed',
			expect.objectContaining({
				tries: DROVR_OUTBOX_CAPTURE_TRIES,
				idempotencyKeys: ['k'],
			}),
		)
	})

	it('keeps the rows when a retried store error clears', async () => {
		const { store, rows } = memoryStore()
		let failures = 1
		const flaky: DrovrOutboxStore = {
			...store,
			insertIgnore: async (inserted) => {
				if (failures-- > 0) throw new Error('Vitess: connection reset')
				await store.insertIgnore(inserted)
			},
		}
		expect(
			await captureDrovrOutbox({
				store: flaky,
				target: PROD,
				entries: [outboxEntryForEvent(event('k'), 'live')],
				reason: 'x',
				now: NOW,
				log: log(),
				sleep: async () => undefined,
			}),
		).toEqual({ status: 'outboxed', count: 1 })
		expect(rows.size).toBe(1)
	})

	it('logs an empty capture with its count of 0', async () => {
		const logger = log()
		expect(
			await captureDrovrOutbox({
				store: memoryStore().store,
				target: PROD,
				entries: [],
				reason: 'owner read failed',
				now: NOW,
				log: logger,
			}),
		).toEqual({ status: 'outboxed', count: 0 })
		expect(logger.warn).toHaveBeenCalledWith(
			'drovr.outbox.captured',
			expect.objectContaining({ count: 0 }),
		)
	})

	it('keeps a signup under its submission id', () => {
		expect(
			outboxEntryForSignup({
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				formId: 'form-1',
				occurredAt: NOW.toISOString(),
				submissionId: 'submission-1',
				source: { page: '/' },
			}),
		).toMatchObject({
			endpoint: 'signups',
			idempotencyKey: 'submission-1',
			journeyId: 'signup:form-1',
			source: 'signup',
		})
	})
})

describe('runDrovrOutboxReplay', () => {
	it('marks a 2xx delivered and counts it', async () => {
		const pending = row()
		const { store, rows } = memoryStore([pending])
		const { run } = replay(store, async () => ({
			kind: 'delivered',
			httpStatus: 200,
		}))
		expect(await run).toMatchObject({ delivered: 1, failed: 0, alert: [] })
		expect(rows.get(pending.id)).toMatchObject({
			status: 'delivered',
			attempts: 1,
			deliveredAt: NOW.toISOString(),
		})
	})

	it.each([500, 503])(
		'keeps a %i pending with backoff, honouring Retry-After',
		async (httpStatus) => {
			const pending = row({ attempts: 2 })
			const { store, rows } = memoryStore([pending])
			const { run } = replay(store, async () => ({
				kind: 'failed',
				transient: true,
				httpStatus,
				reason: `drovr answered ${httpStatus}`,
				retryAfterMs: 10 * 60_000,
			}))
			expect(await run).toMatchObject({ failed: 1, delivered: 0 })
			// max(2^2 minutes, Retry-After 10 minutes)
			expect(rows.get(pending.id)).toMatchObject({
				status: 'pending',
				attempts: 3,
				lastStatus: httpStatus,
				nextAttemptAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
			})
		},
	)

	it('rejects a 4xx for good and alerts', async () => {
		const pending = row()
		const { store, rows } = memoryStore([pending])
		const { run, logger } = replay(store, async () => ({
			kind: 'rejected',
			httpStatus: 422,
			detail: { type: 'invalid' },
		}))
		expect((await run).alert).toContain('rejected')
		expect(rows.get(pending.id)).toMatchObject({
			status: 'rejected',
			lastStatus: 422,
		})
		expect(logger.error).toHaveBeenCalledWith(
			'drovr.outbox.rejected',
			expect.objectContaining({ idempotencyKey: pending.idempotencyKey }),
		)
	})

	it('settles an expected final answer without alerting', async () => {
		const pending = row()
		const { store, rows } = memoryStore([pending])
		const { run } = replay(store, async () => ({
			kind: 'settled',
			httpStatus: 409,
			detail: 'owner-stop-never-born',
		}))
		expect((await run).alert).toEqual([])
		expect(rows.get(pending.id)?.status).toBe('delivered')
	})

	it('holds a birth that has failed to land for 24 hours, unposted, and alerts', async () => {
		const stale = row({
			body: event('old-birth', { type: 'contact.created' }),
			firstFailedAt: minutesAgo(24 * 60 + 1),
		})
		const { store, rows } = memoryStore([stale])
		const post = vi.fn()
		const receipt = await replay(store, post).run
		expect(post).not.toHaveBeenCalled()
		expect(receipt.held).toBe(1)
		expect(receipt.alert).toContain('held')
		expect(receipt.depth.held).toBe(1)
		expect(rows.get(stale.id)?.status).toBe('held')
	})

	it('row 201g composes with row 204: a birth failing for over a day is held, never clamped and sent; a younger one posts clamped', async () => {
		const posted: DrovrShadowEvent[] = []
		const post = (row: DrovrOutboxRow) =>
			postDrovrOutboxRow(row, {
				readBirthOptOuts: async () => [],
				info: vi.fn(),
				ingestUrl: 'https://drovr.test/events',
				apiKeyFor: () => 'k',
				fanOut: async (events) => [...events],
				isNeverBornOwnerStop: () => false,
				deliver: (args) =>
					deliverDrovrShadowEvent({
						...args,
						clampAt: NOW.getTime(),
						info: vi.fn(),
						fetcher: vi.fn(async (_url, init) => {
							posted.push(JSON.parse(String(init?.body)))
							return new Response('{}', { status: 202 })
						}),
					}),
			})
		const stale = row({
			body: event('stale-birth', {
				type: 'contact.created',
				occurredAt: minutesAgo(25 * 60),
			}),
			firstFailedAt: minutesAgo(24 * 60 + 1),
		})
		const young = row({
			body: event('young-birth', {
				type: 'contact.created',
				contactId: 'contact-2',
				occurredAt: minutesAgo(23 * 60),
			}),
			firstFailedAt: minutesAgo(23 * 60),
		})
		const { store, rows } = memoryStore([stale, young])
		await replay(store, post).run
		expect(rows.get(stale.id)?.status).toBe('held')
		expect(posted.map((e) => [e.idempotencyKey, e.occurredAt])).toEqual([
			['young-birth', minutesAgo(5)],
		])
	})

	it('holds an evergreen start failing for over a day like any birth, and gates its journey behind it (row 201g, the hawk)', async () => {
		const start = row({
			body: event('evergreen-start', {
				type: 'course.sequence-exhausted',
				journeyId: 'crash-course-evergreen-offer',
				occurredAt: minutesAgo(25 * 60),
			}),
			firstFailedAt: minutesAgo(24 * 60 + 1),
		})
		const later = row({
			body: event('evergreen-coupon', {
				type: 'coupon.issued',
				journeyId: 'crash-course-evergreen-offer',
				occurredAt: minutesAgo(20),
			}),
		})
		const skills = row({
			body: event('skills-exhausted', {
				type: 'course.sequence-exhausted',
				contactId: 'contact-2',
				occurredAt: minutesAgo(25 * 60),
			}),
			firstFailedAt: minutesAgo(3 * 24 * 60),
		})
		const { store, rows } = memoryStore([start, later, skills])
		const post = vi.fn(async (_row: DrovrOutboxRow) => ({
			kind: 'delivered' as const,
		}))
		const receipt = await replay(store, post).run
		expect(rows.get(start.id)?.status).toBe('held')
		expect(receipt.held).toBe(1)
		expect(receipt.skippedBehindBirth).toBe(1)
		expect(rows.get(later.id)?.status).toBe('pending')
		// The skills course's exhaustion is a fact: late, it is still right.
		expect(post.mock.calls.map(([r]) => r.idempotencyKey)).toEqual([
			'skills-exhausted',
		])
	})

	it('holds by how long the birth has failed, not by when it happened', async () => {
		// A directory birth replayed from an old Kit createdAt: first failed
		// minutes ago, so it posts.
		const backfill = row({
			body: event('kit-birth', {
				type: 'contact.created',
				journeyId: 'contact-directory',
				occurredAt: minutesAgo(400 * 24 * 60),
			}),
			firstFailedAt: minutesAgo(10),
		})
		const { store } = memoryStore([backfill])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		await replay(store, post).run
		expect(post).toHaveBeenCalledOnce()
	})

	it('never holds a fact: a late stop or purchase is still right to deliver', async () => {
		const stop = row({
			body: event('late-stop', { type: 'contact.unsubscribed' }),
			firstFailedAt: minutesAgo(3 * 24 * 60),
		})
		const { store, rows } = memoryStore([stop])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		await replay(store, post).run
		expect(post).toHaveBeenCalledOnce()
		expect(rows.get(stop.id)?.status).toBe('delivered')
	})

	it('posts a released held birth despite its age', async () => {
		const released = row({
			body: event('old', { type: 'contact.created' }),
			firstFailedAt: minutesAgo(3 * 24 * 60),
			releasedAt: minutesAgo(5),
		})
		const { store } = memoryStore([released])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		await replay(store, post).run
		expect(post).toHaveBeenCalledOnce()
	})

	it("posts a contact's birth first, and holds its facts back while the birth fails", async () => {
		const at = minutesAgo(60)
		const fact = row({
			body: event('fact', { occurredAt: at }),
			nextAttemptAt: minutesAgo(3),
		})
		const birth = row({
			body: event('birth', { occurredAt: at, type: 'contact.created' }),
			nextAttemptAt: minutesAgo(2),
		})
		fact.occurredAt = at
		birth.occurredAt = at
		expect(replayOrder([fact, birth]).map((r) => r.idempotencyKey)).toEqual([
			'birth',
			'fact',
		])
		const { store, rows } = memoryStore([fact, birth])
		const post = vi.fn(async (_row: DrovrOutboxRow) => ({
			kind: 'failed' as const,
			transient: true,
			httpStatus: 503,
			reason: 'drovr answered 503',
		}))
		const receipt = await replay(store, post).run
		expect(post).toHaveBeenCalledOnce()
		expect(post.mock.calls[0]![0].idempotencyKey).toBe('birth')
		expect(receipt.skippedBehindBirth).toBe(1)
		expect(rows.get(fact.id)?.attempts).toBe(0)
	})

	it('opens the circuit after three consecutive failures', async () => {
		const pending = Array.from({ length: 6 }, (_, i) =>
			row({ body: event(`k${i}`, { contactId: `contact-${i}` }) }),
		)
		for (const r of pending) r.contactId = r.body.contactId
		const { store } = memoryStore(pending)
		const post = vi.fn(async () => ({
			kind: 'failed' as const,
			transient: true,
			httpStatus: 503,
			reason: 'down',
		}))
		const receipt = await replay(store, post).run
		expect(post).toHaveBeenCalledTimes(3)
		expect(receipt.circuitOpen).toBe(true)
	})

	it('stops taking rows once its time budget is spent', async () => {
		const pending = [row(), row()]
		const { store } = memoryStore(pending)
		let clock = NOW.getTime()
		const post = vi.fn(async () => {
			clock += 60_000
			return { kind: 'delivered' as const }
		})
		const receipt = await replay(store, post, {
			now: () => new Date(clock),
			budgetMs: 30_000,
		}).run
		expect(post).toHaveBeenCalledOnce()
		expect(receipt.budgetSpent).toBe(true)
	})

	it("only ever takes its own target's rows", async () => {
		const preview = row({ target: PREVIEW })
		const { store, rows } = memoryStore([preview])
		const post = vi.fn()
		await replay(store, post).run
		expect(post).not.toHaveBeenCalled()
		expect(rows.get(preview.id)?.status).toBe('pending')
	})

	it('deletes delivered rows after 7 days and keeps held and rejected rows (retention)', async () => {
		expect(DROVR_OUTBOX_DELIVERED_RETENTION_MS).toBe(7 * 24 * 60 * 60_000)
		const old = minutesAgo(7 * 24 * 60 + 1)
		const recent = minutesAgo(7 * 24 * 60 - 60)
		const expired = row({ status: 'delivered', deliveredAt: old })
		const kept = row({ status: 'delivered', deliveredAt: recent })
		const held = row({ status: 'held', createdAt: old, firstFailedAt: old })
		const rejected = row({
			status: 'rejected',
			createdAt: old,
			firstFailedAt: old,
		})
		const { store, rows } = memoryStore([expired, kept, held, rejected])
		const receipt = await replay(store, vi.fn()).run
		expect(receipt.purged).toBe(1)
		expect(rows.has(expired.id)).toBe(false)
		expect(rows.has(kept.id)).toBe(true)
		expect(rows.has(held.id)).toBe(true)
		expect(rows.has(rejected.id)).toBe(true)
	})

	it('logs depth every run and alerts past 25 pending or 60 minutes', async () => {
		const many = Array.from({ length: 26 }, () =>
			row({ nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString() }),
		)
		const { store } = memoryStore(many)
		const { run, logger } = replay(store, vi.fn())
		expect((await run).alert).toEqual(['pending'])
		expect(logger.info).toHaveBeenCalledWith(
			'drovr.outbox.depth',
			expect.objectContaining({ pending: 26 }),
		)
		expect(logger.error).toHaveBeenCalledWith(
			'drovr.outbox.alert',
			expect.objectContaining({ reasons: ['pending'], pending: 26 }),
		)

		const oldest = row({
			firstFailedAt: minutesAgo(61),
			nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString(),
		})
		const aged = replay(memoryStore([oldest]).store, vi.fn())
		expect((await aged.run).alert).toEqual(['oldest'])
	})

	it('logs depth at steady state without an alert', async () => {
		const { run, logger } = replay(memoryStore().store, vi.fn())
		expect((await run).alert).toEqual([])
		expect(logger.info).toHaveBeenCalledWith(
			'drovr.outbox.depth',
			expect.objectContaining({ pending: 0, held: 0, rejected: 0 }),
		)
		expect(logger.error).not.toHaveBeenCalled()
	})
})

describe('row 204 round 2: births gate their contact, and only drovr being down trips the breaker', () => {
	const failedTransient = {
		kind: 'failed' as const,
		transient: true,
		httpStatus: 503,
		reason: 'drovr answered 503',
	}

	it('never lets a fact overtake its birth, however many runs the birth keeps failing', async () => {
		const at = minutesAgo(30)
		const birth = row({
			body: event('birth', { type: 'contact.created', occurredAt: at }),
		})
		const fact = row({ body: event('answer', { occurredAt: at }) })
		const { store, rows } = memoryStore([birth, fact])
		let clock = NOW.getTime()
		let drovrUp = false
		const posted: string[] = []
		const post = vi.fn(async (r: DrovrOutboxRow) => {
			posted.push(r.idempotencyKey)
			return drovrUp ? { kind: 'delivered' as const } : failedTransient
		})
		// Six runs an hour apart: the birth's backoff grows past the fact's
		// own nextAttemptAt, which is exactly when a fact used to post alone.
		for (let run = 0; run < 6; run += 1) {
			await replay(store, post, { now: () => new Date(clock) }).run
			clock += 60 * 60_000
		}
		expect(posted.every((key) => key === 'birth')).toBe(true)
		expect(rows.get(fact.id)?.attempts).toBe(0)
		// Once the birth lands, the fact follows (at the birth's next attempt).
		drovrUp = true
		for (let run = 0; run < 3; run += 1) {
			await replay(store, post, { now: () => new Date(clock) }).run
			clock += 60 * 60_000
		}
		expect(rows.get(birth.id)?.status).toBe('delivered')
		expect(rows.get(fact.id)?.status).toBe('delivered')
		expect(posted.indexOf('answer')).toBeGreaterThan(
			posted.lastIndexOf('birth'),
		)
	})

	it("keeps a held birth's facts back and moves them an hour on", async () => {
		const birth = row({
			body: event('birth', { type: 'contact.created' }),
			firstFailedAt: minutesAgo(25 * 60),
		})
		const fact = row({ body: event('answer') })
		const { store, rows } = memoryStore([birth, fact])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		const receipt = await replay(store, post).run
		expect(post).not.toHaveBeenCalled()
		expect(receipt).toMatchObject({ held: 1, skippedBehindBirth: 1 })
		expect(rows.get(fact.id)?.nextAttemptAt).toBe(
			new Date(NOW.getTime() + DROVR_OUTBOX_HELD_BIRTH_WAIT_MS).toISOString(),
		)
		// Next run: the held birth is not due, and still gates the fact.
		await replay(store, post, {
			now: () => new Date(NOW.getTime() + DROVR_OUTBOX_HELD_BIRTH_WAIT_MS),
		}).run
		expect(post).not.toHaveBeenCalled()
	})

	it('gates only the birth journey, and a signup gates every row of its contact', async () => {
		const birth = row({
			body: event('evergreen-birth', {
				type: 'contact.created',
				journeyId: 'crash-course-evergreen-offer',
			}),
			nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString(),
		})
		const otherJourney = row({ body: event('skills-answer') })
		const { store } = memoryStore([birth, otherJourney])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		await replay(store, post).run
		expect(post).toHaveBeenCalledOnce()

		const signupEntry = outboxEntryForSignup({
			tenantId: 'org-aihero',
			contactId: 'contact-1',
			formId: 'form-1',
			occurredAt: minutesAgo(30),
			submissionId: 'submission-1',
			source: { page: '/' },
		})
		const signup: DrovrOutboxRow = {
			...row(),
			...signupEntry,
			dedupeKey: drovrOutboxDedupeKey(PROD, signupEntry),
			nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString(),
		}
		const gated = memoryStore([signup, row({ body: event('skills-answer-2') })])
		const post2 = vi.fn(async () => ({ kind: 'delivered' as const }))
		const receipt = await replay(gated.store, post2).run
		expect(post2).not.toHaveBeenCalled()
		expect(receipt.skippedBehindBirth).toBe(1)
	})

	it('never counts a missing key, a 409 event-not-live or a 4xx toward the breaker', async () => {
		const stuck = Array.from({ length: 5 }, (_, i) =>
			row({ body: event(`no-key-${i}`, { contactId: `stuck-${i}` }) }),
		)
		for (const r of stuck) r.contactId = r.body.contactId
		const good = row({
			body: event('good', { contactId: 'fine', occurredAt: minutesAgo(1) }),
		})
		good.contactId = 'fine'
		good.occurredAt = good.body.occurredAt
		const { store, rows } = memoryStore([...stuck, good])
		const post = vi.fn(async (r: DrovrOutboxRow) =>
			r.contactId === 'fine'
				? { kind: 'delivered' as const }
				: {
						kind: 'failed' as const,
						transient: false,
						reason: 'no drovr key for tenant org-aihero-shadow',
					},
		)
		const receipt = await replay(store, post).run
		expect(receipt.circuitOpen).toBe(false)
		expect(rows.get(good.id)?.status).toBe('delivered')
	})

	it('resets the breaker on a rejection: drovr answered', async () => {
		const outcomes: DrovrOutboxPostOutcome[] = [
			failedTransient,
			failedTransient,
			{ kind: 'rejected', httpStatus: 422, detail: 'bad' },
			failedTransient,
			failedTransient,
			{ kind: 'delivered' },
		]
		const pending = outcomes.map((_, i) =>
			row({
				body: event(`k${i}`, {
					contactId: `c${i}`,
					occurredAt: minutesAgo(60 - i),
				}),
			}),
		)
		for (const r of pending) {
			r.contactId = r.body.contactId
			r.occurredAt = r.body.occurredAt
		}
		const { store } = memoryStore(pending)
		let call = 0
		const post = vi.fn(async () => outcomes[call++]!)
		const receipt = await replay(store, post).run
		expect(post).toHaveBeenCalledTimes(6)
		expect(receipt.circuitOpen).toBe(false)
	})

	it('logs a refused owner copy with its own key (S5)', async () => {
		const pending = row()
		const { store } = memoryStore([pending])
		const { run, logger } = replay(store, async () => ({
			kind: 'rejected',
			httpStatus: 422,
			detail: { type: 'invalid' },
			idempotencyKey: `owner:${pending.idempotencyKey}`,
		}))
		expect((await run).rejected).toBe(1)
		expect(logger.error).toHaveBeenCalledWith(
			'drovr.outbox.rejected',
			expect.objectContaining({
				idempotencyKey: pending.idempotencyKey,
				rejectedCopyKey: `owner:${pending.idempotencyKey}`,
			}),
		)
	})

	it('resets the breaker on a delivery: drovr is answering (#339 delta)', async () => {
		const outcomes: DrovrOutboxPostOutcome[] = [
			failedTransient,
			failedTransient,
			{ kind: 'delivered' },
			failedTransient,
			failedTransient,
			{ kind: 'delivered' },
		]
		const pending = outcomes.map((_, i) =>
			row({
				body: event(`d${i}`, {
					contactId: `d${i}`,
					occurredAt: minutesAgo(60 - i),
				}),
			}),
		)
		for (const r of pending) {
			r.contactId = r.body.contactId
			r.occurredAt = r.body.occurredAt
		}
		const { store } = memoryStore(pending)
		let call = 0
		const post = vi.fn(async () => outcomes[call++]!)
		const receipt = await replay(store, post).run
		expect(post).toHaveBeenCalledTimes(6)
		expect(receipt.circuitOpen).toBe(false)
	})

	it('counts a thrown post as transient: three open the circuit (#339 delta)', async () => {
		const pending = Array.from({ length: 5 }, (_, i) =>
			row({ body: event(`t${i}`, { contactId: `t${i}` }) }),
		)
		for (const r of pending) r.contactId = r.body.contactId
		const { store, rows } = memoryStore(pending)
		const post = vi.fn(async () => {
			throw new TypeError('fetch failed')
		})
		const receipt = await replay(store, post).run
		expect(post).toHaveBeenCalledTimes(3)
		expect(receipt.circuitOpen).toBe(true)
		expect([...rows.values()].filter((r) => r.attempts === 1)).toHaveLength(3)
	})

	it.each([
		['failed', failedTransient],
		['rejected', { kind: 'rejected' as const, httpStatus: 422, detail: 'bad' }],
	])(
		"holds a contact's later rows back for the rest of the run once one is %s, and posts them next run (#339 delta)",
		async (_label, first) => {
			const earlier = row({
				body: event('first', { occurredAt: minutesAgo(20) }),
			})
			const later = row({
				body: event('second', { occurredAt: minutesAgo(10) }),
			})
			earlier.occurredAt = earlier.body.occurredAt
			later.occurredAt = later.body.occurredAt
			const { store, rows } = memoryStore([earlier, later])
			const posted: string[] = []
			const post = vi.fn(async (r: DrovrOutboxRow) => {
				posted.push(r.idempotencyKey)
				return r.idempotencyKey === 'first'
					? (first as DrovrOutboxPostOutcome)
					: { kind: 'delivered' as const }
			})
			const receipt = await replay(store, post).run
			// Within the run, the contact's order holds: the later row waits.
			expect(posted).toEqual(['first'])
			expect(receipt.skippedBehindBirth).toBe(1)
			expect(rows.get(later.id)?.attempts).toBe(0)
			// Neither is a birth, so nothing gates the next run: it goes out.
			await replay(store, post).run
			expect(rows.get(later.id)?.status).toBe('delivered')
		},
	)

	it('counts a settled row as settled, not delivered', async () => {
		const { store, rows } = memoryStore([row()])
		const receipt = await replay(store, async () => ({
			kind: 'settled',
			detail: 'nothing-deliverable',
		})).run
		expect(receipt).toMatchObject({ settled: 1, delivered: 0 })
		expect([...rows.values()][0]?.status).toBe('delivered')
	})
})

describe('row 204 round 2: shadow rows never poison the replay (MUST 2)', () => {
	it("settles shadow rows with nothing owed and still posts the good row, with prod's keys", async () => {
		const shadowStop = (i: number) => {
			const body = event(`aihero:stop:${i}`, {
				tenantId: 'org-aihero-shadow' as never,
				contactId: `unowned-${i}`,
				type: 'contact.unsubscribed',
				occurredAt: minutesAgo(60 - i),
			})
			const entry = outboxEntryForEvent(body, 'fallback', { needsFanOut: true })
			return row({
				...entry,
				body,
				dedupeKey: drovrOutboxDedupeKey(PROD, entry),
			})
		}
		const poison = [shadowStop(1), shadowStop(2), shadowStop(3)]
		const good = row({
			body: event('owner:answer', {
				contactId: 'owned',
				occurredAt: minutesAgo(10),
			}),
		})
		good.contactId = 'owned'
		good.occurredAt = good.body.occurredAt
		const { store, rows } = memoryStore([...poison, good])
		const deliver = vi.fn(async () => ({ status: 'accepted' as const }))
		const receipt = await replay(store, (r) =>
			postDrovrOutboxRow(r, {
				readBirthOptOuts: async () => [],
				info: vi.fn(),
				ingestUrl: 'https://drovr.example/events',
				apiKeyFor: (tenantId) =>
					tenantId === 'org-aihero' ? 'authority-key' : undefined,
				deliver,
				// Nobody owns the three: the fan-out adds no owner copy.
				fanOut: async (events) => [...events],
				isNeverBornOwnerStop: () => false,
			}),
		).run
		expect(receipt).toMatchObject({
			settled: 3,
			delivered: 1,
			failed: 0,
			circuitOpen: false,
		})
		expect(deliver).toHaveBeenCalledOnce()
		expect(rows.get(good.id)?.status).toBe('delivered')
		for (const r of poison) expect(rows.get(r.id)?.status).toBe('delivered')
	})
})

describe('row 204b: an owed stop holds its contact back', () => {
	const failedTransient = {
		kind: 'failed' as const,
		transient: true,
		httpStatus: 503,
		reason: 'drovr answered 503',
	}
	const inAnHour = new Date(NOW.getTime() + 60 * 60_000).toISOString()
	const stopRow = (
		key: string,
		type: string,
		occurredAt: string,
		overrides: Omit<Partial<DrovrOutboxRow>, 'body'> = {},
	) =>
		row({
			body: event(key, {
				type: type as DrovrShadowEvent['type'],
				journeyId: 'crash-course-evergreen-offer',
				occurredAt,
			}),
			...overrides,
		})

	it('a pending stop → the later fact waits, however many runs the stop keeps failing, then follows it', async () => {
		const stop = stopRow('stop', 'purchase.recorded', minutesAgo(30))
		const fact = row({ body: event('answer', { occurredAt: minutesAgo(20) }) })
		const { store, rows } = memoryStore([stop, fact])
		let clock = NOW.getTime()
		let drovrUp = false
		const posted: string[] = []
		const post = vi.fn(async (r: DrovrOutboxRow) => {
			posted.push(r.idempotencyKey)
			return drovrUp ? { kind: 'delivered' as const } : failedTransient
		})
		for (let run = 0; run < 6; run += 1) {
			await replay(store, post, { now: () => new Date(clock) }).run
			clock += 60 * 60_000
		}
		expect(posted.every((key) => key === 'stop')).toBe(true)
		expect(rows.get(fact.id)?.attempts).toBe(0)
		drovrUp = true
		for (let run = 0; run < 3; run += 1) {
			await replay(store, post, { now: () => new Date(clock) }).run
			clock += 60 * 60_000
		}
		expect(rows.get(stop.id)?.status).toBe('delivered')
		expect(rows.get(fact.id)?.status).toBe('delivered')
		expect(posted.indexOf('answer')).toBeGreaterThan(posted.lastIndexOf('stop'))
	})

	it('holds a later fact behind a stop that is not due this run, moves it to the stop, and logs why', async () => {
		const stop = stopRow('stop', 'purchase.recorded', minutesAgo(30), {
			nextAttemptAt: inAnHour,
		})
		const fact = row({ body: event('answer', { occurredAt: minutesAgo(20) }) })
		const { store, rows } = memoryStore([stop, fact])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		const { run, logger } = replay(store, post)
		const receipt = await run
		expect(post).not.toHaveBeenCalled()
		expect(receipt.skippedBehindStop).toBe(1)
		expect(rows.get(fact.id)?.nextAttemptAt).toBe(inAnHour)
		expect(logger.info).toHaveBeenCalledWith(
			'drovr.outbox.behind_stop',
			expect.objectContaining({
				idempotencyKey: 'answer',
				stopEventType: 'purchase.recorded',
				stopStatus: 'pending',
			}),
		)
	})

	it('still posts a fact from before the stop: it happened first', async () => {
		const stop = stopRow('stop', 'contact.unsubscribed', minutesAgo(20), {
			nextAttemptAt: inAnHour,
		})
		const earlier = row({
			body: event('answer', { occurredAt: minutesAgo(30) }),
		})
		const { store, rows } = memoryStore([stop, earlier])
		await replay(store, async () => ({ kind: 'delivered' })).run
		expect(rows.get(earlier.id)?.status).toBe('delivered')
	})

	it('never holds a stop behind another stop', async () => {
		const purchase = stopRow('purchase', 'purchase.recorded', minutesAgo(30), {
			nextAttemptAt: inAnHour,
		})
		const unsubscribe = stopRow(
			'unsubscribe',
			'contact.unsubscribed',
			minutesAgo(20),
		)
		const { store, rows } = memoryStore([purchase, unsubscribe])
		await replay(store, async () => ({ kind: 'delivered' })).run
		expect(rows.get(unsubscribe.id)?.status).toBe('delivered')
	})

	it('fails closed behind a refused stop: the fact waits an hour at a time until a human retires the stop', async () => {
		const stop = stopRow('stop', 'purchase.recorded', minutesAgo(30), {
			status: 'rejected',
		})
		const fact = row({ body: event('answer', { occurredAt: minutesAgo(20) }) })
		const { store, rows } = memoryStore([stop, fact])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		const receipt = await replay(store, post).run
		expect(post).not.toHaveBeenCalled()
		expect(receipt.skippedBehindStop).toBe(1)
		expect(rows.get(fact.id)?.nextAttemptAt).toBe(inAnHour)
		// Retired by hand (the runbook): the fact follows at its next run.
		await store.update(stop.id, {
			status: 'delivered',
			deliveredAt: minutesAgo(0),
		})
		await replay(store, post, { now: () => new Date(inAnHour) }).run
		expect(rows.get(fact.id)?.status).toBe('delivered')
	})

	it('holds a fact refused this very run behind the stop from then on', async () => {
		const stop = stopRow('stop', 'purchase.recorded', minutesAgo(30))
		const fact = row({
			body: event('answer', { occurredAt: minutesAgo(20) }),
			nextAttemptAt: minutesAgo(0),
		})
		const { store, rows } = memoryStore([stop, fact])
		const post = vi.fn(async (r: DrovrOutboxRow) =>
			r.idempotencyKey === 'stop'
				? { kind: 'rejected' as const, httpStatus: 422, detail: 'bad' }
				: { kind: 'delivered' as const },
		)
		await replay(store, post).run
		// Refused in this run, the stop now holds the fact an hour at a time.
		expect(rows.get(fact.id)?.nextAttemptAt).toBe(inAnHour)
		// A later run, the fact due again: the refused stop still holds it.
		await replay(store, post, {
			now: () => new Date(NOW.getTime() + 10 * 60_000),
		}).run
		expect(post.mock.calls.map(([r]) => r.idempotencyKey)).toEqual(['stop'])
		expect(rows.get(fact.id)?.attempts).toBe(0)
	})

	it.each([
		'contact.unsubscribed',
		'contact.bounced',
		'contact.complained',
		'purchase.recorded',
	])('gates on a %s, on every journey of the contact', async (type) => {
		expect(isOutboxStop({ eventType: type })).toBe(true)
		const stop = stopRow('stop', type, minutesAgo(30), {
			nextAttemptAt: inAnHour,
		})
		const otherJourney = row({
			body: event('answer', {
				journeyId: 'value-path-skills-course',
				occurredAt: minutesAgo(20),
			}),
		})
		const otherContact = row({
			body: event('other', {
				contactId: 'contact-2',
				occurredAt: minutesAgo(20),
			}),
		})
		otherContact.contactId = 'contact-2'
		const { store, rows } = memoryStore([stop, otherJourney, otherContact])
		await replay(store, async () => ({ kind: 'delivered' })).run
		expect(rows.get(otherJourney.id)?.attempts).toBe(0)
		expect(rows.get(otherContact.id)?.status).toBe('delivered')
	})

	it('posts the later fact in the same run once the stop lands first', async () => {
		const stop = stopRow('stop', 'purchase.recorded', minutesAgo(30))
		const fact = row({ body: event('answer', { occurredAt: minutesAgo(20) }) })
		const { store, rows } = memoryStore([stop, fact])
		const posted: string[] = []
		await replay(store, async (r) => {
			posted.push(r.idempotencyKey)
			return { kind: 'delivered' }
		}).run
		expect(posted).toEqual(['stop', 'answer'])
		expect(rows.get(fact.id)?.status).toBe('delivered')
	})

	it.each([
		['pending', 11, true],
		['pending', 9, false],
		['rejected', 11, true],
	] as const)(
		'alerts on a %s stop owed for %i minutes: %s',
		async (status, minutes, alerts) => {
			const stop = stopRow('stop', 'contact.unsubscribed', minutesAgo(60), {
				status,
				firstFailedAt: minutesAgo(minutes),
				nextAttemptAt: inAnHour,
			})
			const { store } = memoryStore([stop])
			const { run, logger } = replay(store, async () => ({ kind: 'delivered' }))
			const receipt = await run
			expect(receipt.alert.includes('stop')).toBe(alerts)
			expect(logger.info).toHaveBeenCalledWith(
				'drovr.outbox.depth',
				expect.objectContaining({ oldestOpenStopAgeMin: minutes }),
			)
		},
	)
})

describe('row 204b round 2: the two gates never deadlock, and every queue drains', () => {
	const EVERGREEN = 'crash-course-evergreen-offer'
	const NEWSLETTER = 'newsletter'
	const failed = {
		kind: 'failed' as const,
		transient: true,
		httpStatus: 503,
		reason: 'drovr answered 503',
	}
	const at = (minutes: number, base = NOW) =>
		new Date(base.getTime() - minutes * 60_000).toISOString()
	const ev = (
		key: string,
		contactId: string,
		journeyId: string,
		type: string,
		minutes: number,
		overrides: Omit<Partial<DrovrOutboxRow>, 'body'> = {},
	) =>
		row({
			id: key,
			body: event(key, {
				contactId,
				journeyId: journeyId as DrovrShadowEvent['journeyId'],
				type: type as DrovrShadowEvent['type'],
				occurredAt: at(minutes),
			}),
			...overrides,
		})
	const signupRow = (
		key: string,
		contactId: string,
		minutes: number,
	): DrovrOutboxRow => ({
		...ev(key, contactId, 'signup:newsletter-form', 'signup', minutes),
		endpoint: 'signups',
		eventType: 'signup',
	})
	const delivered = async () => ({ kind: 'delivered' as const })
	const keysPosted = () => {
		const posted: string[] = []
		return {
			posted,
			post: async (r: DrovrOutboxRow) => {
				posted.push(r.idempotencyKey)
				return { kind: 'delivered' as const }
			},
		}
	}

	it("posts an owed birth before the owed stop that waits for it (Opus's probe): both land in one run, stop before any later fact", async () => {
		const rows = [
			// A buyer who then signs up for the newsletter.
			ev('c1-purchase', 'c1', EVERGREEN, 'purchase.recorded', 30),
			signupRow('c1-signup', 'c1', 20),
			ev('c1-later', 'c1', NEWSLETTER, 'value-path.answer-selected', 10),
			// An evergreen purchase before that journey's own birth.
			ev('c2-purchase', 'c2', EVERGREEN, 'purchase.recorded', 35),
			ev('c2-birth', 'c2', EVERGREEN, 'contact.created', 25),
		]
		const { store, rows: stored } = memoryStore(rows)
		const { posted, post } = keysPosted()
		const receipt = await replay(store, post).run
		expect(posted).toEqual([
			'c2-birth',
			'c2-purchase',
			'c1-signup',
			'c1-purchase',
			'c1-later',
		])
		expect([...stored.values()].every((r) => r.status === 'delivered')).toBe(
			true,
		)
		expect(receipt).toMatchObject({
			skippedBehindBirth: 0,
			skippedBehindStop: 0,
		})
	})

	it('drains the probe over 30 hourly runs too, where it used to post nothing', async () => {
		const rows = [
			ev('c1-purchase', 'c1', EVERGREEN, 'purchase.recorded', 30),
			signupRow('c1-signup', 'c1', 20),
			ev('c2-purchase', 'c2', EVERGREEN, 'purchase.recorded', 35),
			ev('c2-birth', 'c2', EVERGREEN, 'contact.created', 25),
		]
		const { store, rows: stored } = memoryStore(rows)
		for (let run = 0; run < 30; run += 1) {
			const now = new Date(NOW.getTime() + run * 60 * 60_000)
			await replay(store, delivered, { now: () => now }).run
		}
		expect([...stored.values()].map((r) => r.status)).toEqual([
			'delivered',
			'delivered',
			'delivered',
			'delivered',
		])
	})

	it('breaks the two-journey cycle too: stop J ← birth J ← stop K ← birth K ← stop J', async () => {
		const rows = [
			ev('stop-j', 'c3', EVERGREEN, 'purchase.recorded', 50),
			ev('stop-k', 'c3', NEWSLETTER, 'contact.unsubscribed', 49),
			ev('birth-j', 'c3', EVERGREEN, 'contact.created', 44),
			ev('birth-k', 'c3', NEWSLETTER, 'contact.created', 43),
			ev('fact-j', 'c3', EVERGREEN, 'email.completed', 30),
		]
		const { store } = memoryStore(rows)
		const { posted, post } = keysPosted()
		await replay(store, post).run
		expect(posted).toEqual(['birth-j', 'stop-j', 'birth-k', 'stop-k', 'fact-j'])
	})

	it('posts a birth ahead of an earlier fact it gates, so both land in one run (round 3)', async () => {
		const fact = ev('fact', 'c15', EVERGREEN, 'email.completed', 30)
		const birth = ev('birth', 'c15', EVERGREEN, 'contact.created', 20)
		const { store } = memoryStore([fact, birth])
		const { posted, post } = keysPosted()
		const receipt = await replay(store, post).run
		expect(posted).toEqual(['birth', 'fact'])
		expect(receipt.skippedBehindBirth).toBe(0)
	})

	it('still holds a birth behind a stop that waits for no birth: the exception is only the cycle', async () => {
		const stop = ev('stop', 'c4', EVERGREEN, 'purchase.recorded', 30)
		const birth = ev('birth', 'c4', NEWSLETTER, 'contact.created', 20)
		const { store, rows: stored } = memoryStore([stop, birth])
		const { posted } = keysPosted()
		const receipt = await replay(store, async (r) => {
			posted.push(r.idempotencyKey)
			return r.idempotencyKey === 'stop' ? failed : { kind: 'delivered' }
		}).run
		expect(posted).toEqual(['stop'])
		expect(receipt.skippedBehindStop).toBe(1)
		expect(stored.get('birth')?.status).toBe('pending')
	})

	it('posts the stop first on a shared instant, and the fact behind it in the same run, whatever the ids (Macroscope L496)', async () => {
		const fact = ev('a-fact', 'c5', EVERGREEN, 'email.completed', 20)
		const stop = ev('z-stop', 'c5', EVERGREEN, 'contact.unsubscribed', 20)
		const { store } = memoryStore([fact, stop])
		const { posted, post } = keysPosted()
		await replay(store, post).run
		expect(posted).toEqual(['z-stop', 'a-fact'])
	})

	it('holds a fact that shares its instant with an owed stop (a tie waits, U1)', async () => {
		// Owed but not due this run: only the stop gate can hold the fact.
		const stop = ev('stop', 'c6', EVERGREEN, 'purchase.recorded', 20, {
			nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
		})
		const fact = ev('fact', 'c6', NEWSLETTER, 'email.completed', 20)
		const { store, rows: stored } = memoryStore([stop, fact])
		const posted: string[] = []
		const receipt = await replay(store, async (r) => {
			posted.push(r.idempotencyKey)
			return { kind: 'delivered' }
		}).run
		expect(posted).toEqual([])
		expect(receipt.skippedBehindStop).toBe(1)
		expect(stored.get('fact')?.status).toBe('pending')
	})

	it('moves a fact to the new next attempt of a stop that failed this run (U8)', async () => {
		const stop = ev('stop', 'c7', EVERGREEN, 'purchase.recorded', 30, {
			attempts: 3,
		})
		// Due now, on another contact's heels: the stop's new time is later.
		const fact = ev('fact', 'c7', NEWSLETTER, 'email.completed', 20)
		const { store, rows: stored } = memoryStore([stop, fact])
		await replay(store, async () => failed).run
		const stopNext = stored.get('stop')!.nextAttemptAt
		expect(stopNext > NOW.toISOString()).toBe(true)
		expect(stored.get('fact')?.nextAttemptAt).toBe(stopNext)
	})

	it('waits behind the earliest owed stop: a refused one an hour on, not a later pending one', async () => {
		const later = ev(
			'later-stop',
			'c8',
			NEWSLETTER,
			'contact.unsubscribed',
			30,
			{
				nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
			},
		)
		const refused = ev(
			'refused-stop',
			'c8',
			EVERGREEN,
			'purchase.recorded',
			40,
			{
				status: 'rejected',
			},
		)
		const fact = ev('fact', 'c8', EVERGREEN, 'email.completed', 20)
		const { store, rows: stored } = memoryStore([later, refused, fact])
		await replay(store, delivered).run
		expect(stored.get('fact')?.nextAttemptAt).toBe(
			new Date(NOW.getTime() + 60 * 60_000).toISOString(),
		)
	})

	it('tells two same-type stops at one instant apart by row id (Macroscope 585)', async () => {
		// The gate list holds the second stop first. It is owed but not due,
		// so only its gate can hold the fact once the first stop lands.
		const second = ev('stop-b', 'c9', EVERGREEN, 'purchase.recorded', 30, {
			nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
		})
		const first = ev('stop-a', 'c9', EVERGREEN, 'purchase.recorded', 30)
		const fact = ev('fact', 'c9', EVERGREEN, 'email.completed', 20)
		const { store, rows: stored } = memoryStore([second, first, fact])
		const receipt = await replay(store, delivered).run
		expect(stored.get('stop-a')?.status).toBe('delivered')
		expect(stored.get('stop-b')?.status).toBe('pending')
		expect(stored.get('fact')?.status).toBe('pending')
		expect(receipt.skippedBehindStop).toBe(1)
	})

	it("puts a failed stop's new time on its own gate, not on its twin's (Macroscope 585)", async () => {
		const in30 = new Date(NOW.getTime() + 30 * 60_000).toISOString()
		// The twin is listed first and owed, not due; the other one fails now.
		const twin = ev('stop-a', 'c14', EVERGREEN, 'purchase.recorded', 30, {
			nextAttemptAt: in30,
		})
		const failing = ev('stop-b', 'c14', EVERGREEN, 'purchase.recorded', 30)
		const fact = ev('fact', 'c14', EVERGREEN, 'email.completed', 20)
		const { store, rows: stored } = memoryStore([twin, failing, fact])
		await replay(store, async () => failed).run
		expect(stored.get('stop-b')!.nextAttemptAt < in30).toBe(true)
		// The fact waits for the twin, which still owes its own later time.
		expect(stored.get('fact')?.nextAttemptAt).toBe(in30)
	})

	it('alerts on a stop owed for over 10 minutes, not at exactly 10', async () => {
		const stop = ev('stop', 'c10', EVERGREEN, 'contact.bounced', 60, {
			firstFailedAt: at(10),
			nextAttemptAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
		})
		const receipt = await replay(memoryStore([stop]).store, delivered).run
		expect(receipt.alert).not.toContain('stop')
	})

	it('keeps a stop a human held gating its facts, without paging on it every 5 minutes (Macroscope 263)', async () => {
		const held = ev('stop', 'c11', EVERGREEN, 'purchase.recorded', 60, {
			status: 'held',
			firstFailedAt: at(600),
		})
		const fact = ev('fact', 'c11', EVERGREEN, 'email.completed', 20)
		const { store, rows: stored } = memoryStore([held, fact])
		const receipt = await replay(store, delivered).run
		expect(receipt.alert).not.toContain('stop')
		expect(receipt.skippedBehindStop).toBe(1)
		expect(stored.get('fact')?.status).toBe('pending')
	})

	it.each([
		['the fact', 'not-a-date', 20],
		['the stop', 20, 'not-a-date'],
	] as const)(
		'fails closed when %s has an instant that does not parse',
		async (_which, factAt, stopAt) => {
			const stop = ev('stop', 'c12', EVERGREEN, 'purchase.recorded', 30, {
				nextAttemptAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
				...(typeof stopAt === 'string' ? { occurredAt: stopAt } : {}),
			})
			const fact = ev('fact', 'c12', NEWSLETTER, 'email.completed', 10, {
				...(typeof factAt === 'string' ? { occurredAt: factAt } : {}),
			})
			const { store, rows: stored } = memoryStore([stop, fact])
			const posted: string[] = []
			await replay(store, async (r) => {
				posted.push(r.idempotencyKey)
				return { kind: 'delivered' }
			}).run
			expect(posted).toEqual([])
			expect(stored.get('fact')?.status).toBe('pending')
		},
	)

	it('holds a later fact behind a stop captured on its first failure; when a retry lands, the fact follows on the next run, not at the window end (round 3)', async () => {
		const retryWindowEnd = new Date(NOW.getTime() + 78 * 60_000).toISOString()
		const stop = ev('stop', 'c13', EVERGREEN, 'purchase.recorded', 5, {
			nextAttemptAt: retryWindowEnd,
			source: 'live',
		})
		const fact = ev('fact', 'c13', EVERGREEN, 'email.completed', 2)
		// Another stop of the contact, still inside its own Inngest retries.
		const otherStop = ev(
			'other-stop',
			'c13',
			NEWSLETTER,
			'contact.unsubscribed',
			1,
			{ nextAttemptAt: retryWindowEnd, source: 'live' },
		)
		const { store, rows: stored } = memoryStore([stop, fact, otherStop])
		const posted: string[] = []
		const post = async (r: DrovrOutboxRow) => {
			posted.push(r.idempotencyKey)
			return { kind: 'delivered' as const }
		}
		// The replay leaves the stop to Inngest: not due, and still a gate.
		await replay(store, post).run
		expect(posted).toEqual([])
		expect(stored.get('fact')?.nextAttemptAt).toBe(retryWindowEnd)
		// A retry lands a minute later: the stop is settled, never posted by
		// the replay, and the fact it held is due again.
		const aMinuteOn = new Date(NOW.getTime() + 60_000)
		const settled = await settleDrovrOutbox({
			store,
			target: PROD,
			entries: [stored.get('stop')!],
			note: 'delivered by an Inngest retry',
			now: aMinuteOn,
			log: log(),
		})
		expect(settled).toBe(1)
		expect(stored.get('stop')?.status).toBe('delivered')
		expect(stored.get('fact')?.nextAttemptAt).toBe(aMinuteOn.toISOString())
		// The other stop keeps its window: pulling it in would race Inngest.
		expect(stored.get('other-stop')?.nextAttemptAt).toBe(retryWindowEnd)
		// The next run, five minutes on, posts the fact; nothing pages oldest.
		const nextRun = new Date(NOW.getTime() + 5 * 60_000)
		const receipt = await replay(store, post, { now: () => nextRun }).run
		expect(posted).toEqual(['fact'])
		expect(receipt.alert).not.toContain('oldest')
	})

	it("drains a mixed queue completely once drovr is back, in a legal order (the hawk's pin b)", async () => {
		const T = (minutes: number) => at(minutes)
		const queue = [
			// c1: a signup, an answer, a purchase, then a fact after it.
			signupRow('c1-signup', 'c1', 60),
			ev('c1-answer', 'c1', NEWSLETTER, 'value-path.answer-selected', 50),
			ev('c1-purchase', 'c1', EVERGREEN, 'purchase.recorded', 40),
			ev('c1-after', 'c1', EVERGREEN, 'email.completed', 30),
			// c2: a purchase before its journey's birth, then more.
			ev('c2-purchase', 'c2', EVERGREEN, 'purchase.recorded', 55),
			ev('c2-birth', 'c2', EVERGREEN, 'contact.created', 45),
			ev('c2-fact', 'c2', EVERGREEN, 'email.completed', 35),
			ev('c2-news-birth', 'c2', NEWSLETTER, 'contact.created', 25),
			// c3: the two-journey cycle, and a fact behind it.
			ev('c3-stop-j', 'c3', EVERGREEN, 'purchase.recorded', 50),
			ev('c3-stop-k', 'c3', NEWSLETTER, 'contact.unsubscribed', 49),
			ev('c3-birth-j', 'c3', EVERGREEN, 'contact.created', 44),
			ev('c3-birth-k', 'c3', NEWSLETTER, 'contact.created', 43),
			ev('c3-fact-j', 'c3', EVERGREEN, 'email.completed', 30),
			// c4: a birth, a stop and a fact at one instant.
			ev('c4-fact', 'c4', NEWSLETTER, 'value-path.answer-selected', 20),
			ev('c4-stop', 'c4', NEWSLETTER, 'contact.bounced', 20),
			ev('c4-birth', 'c4', NEWSLETTER, 'contact.created', 20),
			// c5: an ordinary contact.
			ev('c5-birth', 'c5', NEWSLETTER, 'contact.created', 15),
			ev('c5-fact', 'c5', NEWSLETTER, 'value-path.answer-selected', 10),
			ev('c5-complaint', 'c5', NEWSLETTER, 'contact.complained', 5),
		].map((r) => ({ ...r, firstFailedAt: T(60), nextAttemptAt: T(1) }))
		const byKey = new Map(queue.map((r) => [r.idempotencyKey, r]))
		const { store, rows: stored } = memoryStore(queue)
		// drovr as a contract: nothing lands for a contact it never saw born.
		const born = new Set<string>()
		const posted: string[] = []
		let drovrUp = false
		const post = async (r: DrovrOutboxRow): Promise<DrovrOutboxPostOutcome> => {
			if (!drovrUp) return failed
			if (isOutboxBirth(r)) {
				born.add(
					r.endpoint === 'signups'
						? `${r.contactId}|*`
						: `${r.contactId}|${r.journeyId}`,
				)
			} else if (
				!born.has(`${r.contactId}|${r.journeyId}`) &&
				!born.has(`${r.contactId}|*`)
			) {
				return {
					kind: 'rejected',
					httpStatus: 409,
					detail: 'contact-never-born',
				}
			}
			posted.push(r.idempotencyKey)
			return { kind: 'delivered' }
		}
		let run = 0
		for (; run < 60; run += 1) {
			// Down for the first hour of 5-minute runs, then back.
			drovrUp = run >= 12
			const now = new Date(NOW.getTime() + run * 5 * 60_000)
			await replay(store, post, { now: () => now }).run
			if ([...stored.values()].every((r) => r.status === 'delivered')) break
		}
		expect(
			[...stored.values()].filter((r) => r.status !== 'delivered'),
		).toEqual([])
		expect(posted).toHaveLength(queue.length)
		expect(run).toBeLessThan(30)
		// Legal: a row after the births that gate it; a non-stop after every
		// stop of its contact at or before it, except a birth that goes
		// ahead of a stop waiting for a birth (the deadlock break).
		const index = (key: string) => posted.indexOf(key)
		const gates = (birth: DrovrOutboxRow, other: DrovrOutboxRow) =>
			!isOutboxBirth(other) &&
			birth.contactId === other.contactId &&
			(birth.endpoint === 'signups' || birth.journeyId === other.journeyId)
		for (const r of queue) {
			for (const birth of queue.filter((b) => isOutboxBirth(b) && gates(b, r)))
				expect(
					index(birth.idempotencyKey),
					`${birth.idempotencyKey} before ${r.idempotencyKey}`,
				).toBeLessThan(index(r.idempotencyKey))
			if (isOutboxStop(r)) continue
			for (const stop of queue.filter(
				(s) =>
					isOutboxStop(s) &&
					s.contactId === r.contactId &&
					s.occurredAt <= r.occurredAt,
			)) {
				const stopWaitsForABirth = queue.some(
					(b) => isOutboxBirth(b) && gates(b, stop),
				)
				if (isOutboxBirth(r) && stopWaitsForABirth) continue
				expect(
					index(stop.idempotencyKey),
					`${stop.idempotencyKey} before ${r.idempotencyKey}`,
				).toBeLessThan(index(r.idempotencyKey))
			}
		}
		expect(byKey.size).toBe(queue.length)
	})
})

describe('row 204c: a stop drovr refused is held for a human, never rejected', () => {
	const stopRow = (
		id: string,
		overrides: Omit<Partial<DrovrOutboxRow>, 'body'> = {},
		type = 'purchase.recorded',
	) =>
		row({
			id,
			body: event(id, {
				journeyId: 'crash-course-evergreen-offer',
				type: type as DrovrShadowEvent['type'],
				occurredAt: minutesAgo(30),
			}),
			...overrides,
		})
	const refused = async () => ({
		kind: 'rejected' as const,
		httpStatus: 404,
		detail: { type: 'urn:drovr:problem:unknown-route' },
	})

	it('the replay holds a stop drovr refuses, which still gates its contact, alerts `held`, and shows on the depth line', async () => {
		const stop = stopRow('stop')
		const later = row({
			id: 'later',
			body: event('later', { occurredAt: minutesAgo(5) }),
		})
		const { store, rows: stored } = memoryStore([stop, later])
		const posted: string[] = []
		const { run, logger } = replay(store, async (r) => {
			posted.push(r.idempotencyKey)
			return r.idempotencyKey === 'stop'
				? refused()
				: { kind: 'delivered' as const }
		})
		const receipt = await run
		expect(stored.get('stop')).toMatchObject({
			status: 'held',
			lastStatus: 404,
			attempts: 1,
		})
		expect(posted).toEqual(['stop'])
		expect(stored.get('later')?.status).toBe('pending')
		expect(receipt).toMatchObject({ held: 1, rejected: 0 })
		expect(receipt.alert).toContain('held')
		expect(receipt.alert).not.toContain('stop')
		expect(receipt.depth).toMatchObject({ heldStops: 1 })
		expect(logger.warn).toHaveBeenCalledWith(
			'drovr.outbox.stop_held',
			expect.objectContaining({ httpStatus: 404 }),
		)
		expect(logger.info).toHaveBeenCalledWith(
			'drovr.outbox.depth',
			expect.objectContaining({ heldStops: 1, oldestHeldStopAgeMin: 10 }),
		)
	})

	it('logs a standing line on every run while a stop is held, and an overdue line once the oldest has waited more than a day (the monitors count these)', async () => {
		const quiet = replay(
			memoryStore([row({ id: 'fact', body: event('fact') })]).store,
			refused,
		)
		await quiet.run
		const events = (logger: ReturnType<typeof log>) =>
			[...logger.warn.mock.calls, ...logger.error.mock.calls].map(
				([name]) => name as string,
			)
		expect(events(quiet.logger)).not.toContain(
			'drovr.outbox.stop_held_standing',
		)

		const fresh = replay(
			memoryStore([
				stopRow('held', { status: 'held', firstFailedAt: minutesAgo(24 * 60) }),
			]).store,
			refused,
		)
		await fresh.run
		expect(fresh.logger.warn).toHaveBeenCalledWith(
			'drovr.outbox.stop_held_standing',
			{ target: PROD, heldStops: 1, oldestHeldStopAgeMin: 24 * 60 },
		)
		expect(events(fresh.logger)).not.toContain('drovr.outbox.stop_held_overdue')

		const old = replay(
			memoryStore([
				stopRow('held', {
					status: 'held',
					firstFailedAt: minutesAgo(24 * 60 + 1),
				}),
			]).store,
			refused,
		)
		await old.run
		expect(old.logger.error).toHaveBeenCalledWith(
			'drovr.outbox.stop_held_overdue',
			{ target: PROD, heldStops: 1, oldestHeldStopAgeMin: 24 * 60 + 1 },
		)
	})

	it('a fact drovr refuses on replay is still rejected: only stops are held', async () => {
		const fact = row({ id: 'fact', body: event('fact') })
		const { store, rows: stored } = memoryStore([fact])
		await replay(store, refused).run
		expect(stored.get('fact')?.status).toBe('rejected')
	})

	it('holdDrovrStops holds a new stop, moves an early-captured one from pending to held, and leaves non-stops out', async () => {
		const early = stopRow('early', { nextAttemptAt: minutesAgo(-70) })
		const { store, rows: stored } = memoryStore([early])
		const logger = log()
		const captured = await holdDrovrStops({
			store,
			target: PROD,
			entries: [
				outboxEntryForEvent(early.body as DrovrShadowEvent, 'live'),
				outboxEntryForEvent(
					event('new-stop', { type: 'contact.unsubscribed' }),
					'live',
				),
				outboxEntryForEvent(event('a-fact'), 'live'),
			],
			reason: 'drovr refused the stop (403)',
			httpStatus: 403,
			now: NOW,
			log: logger,
		})
		expect(captured).toEqual({ status: 'outboxed', count: 2 })
		const all = [...stored.values()]
		expect(
			all.map((r) => [r.idempotencyKey, r.status, r.lastStatus]).sort(),
		).toEqual([
			['early', 'held', 403],
			['new-stop', 'held', 403],
		])
		expect(logger.warn).toHaveBeenCalledWith(
			'drovr.outbox.stop_held',
			expect.objectContaining({
				count: 2,
				idempotencyKeys: ['early', 'new-stop'],
			}),
		)
	})

	it('holdDrovrStops writes a new stop held from the start: never a pending moment the replay could post, even if the flip of captured rows fails', async () => {
		const { store, rows: stored } = memoryStore()
		store.holdPending = async () => {
			throw new Error('database went away')
		}
		await expect(
			holdDrovrStops({
				store,
				target: PROD,
				entries: [
					outboxEntryForEvent(
						event('new-stop', { type: 'purchase.recorded' }),
						'live',
					),
				],
				reason: 'drovr refused the stop (404)',
				httpStatus: 404,
				now: NOW,
				log: log(),
			}),
		).rejects.toThrow('database went away')
		expect([...stored.values()].map((r) => r.status)).toEqual(['held'])
	})

	it('holdDrovrStops with no stops writes nothing', async () => {
		const { store, rows: stored } = memoryStore()
		const captured = await holdDrovrStops({
			store,
			target: PROD,
			entries: [outboxEntryForEvent(event('a-fact'), 'live')],
			reason: 'x',
			now: NOW,
			log: log(),
		})
		expect(captured).toEqual({ status: 'outboxed', count: 0 })
		expect(stored.size).toBe(0)
	})

	it('a settled stop pulls forward only the facts that waited behind it, not one waiting out its own backoff (the round 3 nit)', async () => {
		const stop = stopRow('stop', {
			nextAttemptAt: minutesAgo(-70),
			source: 'live',
		})
		const behind = row({
			id: 'behind',
			body: event('behind', { occurredAt: minutesAgo(5) }),
			nextAttemptAt: minutesAgo(-70),
			lastError: DROVR_OUTBOX_BEHIND_STOP_NOTE,
		})
		const ownBackoff = row({
			id: 'own',
			body: event('own', { occurredAt: minutesAgo(5) }),
			nextAttemptAt: minutesAgo(-30),
			lastError: 'drovr answered 503',
		})
		const { store, rows: stored } = memoryStore([stop, behind, ownBackoff])
		await settleDrovrOutbox({
			store,
			target: PROD,
			entries: [stored.get('stop')!],
			note: 'delivered by an Inngest retry',
			now: NOW,
			log: log(),
		})
		expect(stored.get('behind')?.nextAttemptAt).toBe(NOW.toISOString())
		expect(stored.get('own')?.nextAttemptAt).toBe(minutesAgo(-30))
	})

	it('the replay marks a fact it moves behind a stop, so a settle can find it', async () => {
		const stop = stopRow('stop', { nextAttemptAt: minutesAgo(-70) })
		const fact = row({
			id: 'fact',
			body: event('fact', { occurredAt: minutesAgo(5) }),
		})
		const { store, rows: stored } = memoryStore([stop, fact])
		await replay(store, async () => ({ kind: 'delivered' as const })).run
		expect(stored.get('fact')).toMatchObject({
			nextAttemptAt: minutesAgo(-70),
			lastError: DROVR_OUTBOX_BEHIND_STOP_NOTE,
		})
	})

	it('a stop the straggler retry owns does not page `stop` while it waits, only after 48 h', async () => {
		const waiting = stopRow(
			'deferred',
			{
				source: 'contactSync',
				firstFailedAt: minutesAgo(47 * 60),
				nextAttemptAt: minutesAgo(-60),
			},
			'contact.unsubscribed',
		)
		const quiet = await replay(memoryStore([waiting]).store, refused).run
		expect(quiet.alert).not.toContain('stop')
		expect(quiet.depth.oldestDeferredStopFailedAt).toBe(minutesAgo(47 * 60))
		const overdue = stopRow(
			'overdue',
			{
				source: 'contactSync',
				firstFailedAt: minutesAgo(48 * 60 + 1),
				nextAttemptAt: minutesAgo(-60),
			},
			'contact.unsubscribed',
		)
		const loud = await replay(memoryStore([overdue]).store, refused).run
		expect(loud.alert).toContain('stop')
		// Any other owed stop still pages at 10 minutes.
		const live = stopRow('live', {
			firstFailedAt: minutesAgo(11),
			nextAttemptAt: minutesAgo(-60),
		})
		const paged = await replay(memoryStore([live]).store, refused).run
		expect(paged.alert).toContain('stop')
	})
})
