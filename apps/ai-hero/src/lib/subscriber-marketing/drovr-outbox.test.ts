import { describe, expect, it, vi } from 'vitest'

import {
	captureDrovrOutbox,
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
	isOutboxStop,
	outboxEntryForEvent,
	outboxEntryForSignup,
	parseRetryAfterMs,
	replayOrder,
	runDrovrOutboxReplay,
	type DrovrOutboxDepth,
	type DrovrOutboxPostOutcome,
	type DrovrOutboxRow,
	type DrovrOutboxStore,
} from './drovr-outbox'
import { postDrovrOutboxRow } from './drovr-outbox-replay-post'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

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
							(row.status !== 'delivered' && isOutboxStop(row))),
				)
				.map(
					({
						contactId,
						journeyId,
						endpoint,
						eventType,
						status,
						nextAttemptAt,
						occurredAt,
					}) => ({
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
						.filter((row) => row.status !== 'delivered' && isOutboxStop(row))
						.map((row) => row.firstFailedAt)
						.sort()[0] ?? null,
			}
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
