import { describe, expect, it, vi } from 'vitest'

import {
	captureDrovrOutbox,
	DROVR_OUTBOX_DELIVERED_RETENTION_MS,
	DROVR_SEND_BACKOFF_MS,
	DROVR_SEND_RETRIES,
	drovrOutboxDedupeKey,
	drovrOutboxTarget,
	DrovrOutboxUnavailableError,
	drovrReplayDelayMs,
	drovrRetryDelayMs,
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
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const PROD = 'https://drovr.example#production'
const PREVIEW = 'https://drovr-stage.example#preview:worker/x'

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
	it('is the drovr origin plus the Vercel environment', () => {
		expect(
			drovrOutboxTarget({
				DROVR_SHADOW_INGEST_URL: 'https://drovr.example/events',
				VERCEL_ENV: 'production',
			}),
		).toBe(PROD)
	})

	it('scopes a preview to its branch, so no preview replays another one', () => {
		expect(
			drovrOutboxTarget({
				DROVR_SHADOW_INGEST_URL: 'https://drovr-stage.example/events',
				VERCEL_ENV: 'preview',
				VERCEL_GIT_COMMIT_REF: 'worker/x',
			}),
		).toBe(PREVIEW)
	})

	it('has no target without an ingest URL', () => {
		expect(drovrOutboxTarget({ VERCEL_ENV: 'production' })).toBeUndefined()
		expect(
			drovrOutboxTarget({ DROVR_SHADOW_INGEST_URL: 'not a url' }),
		).toBeUndefined()
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

	it('throws any other store error, so the step retries the capture', async () => {
		await expect(
			captureDrovrOutbox({
				store: {
					...memoryStore().store,
					insertIgnore: async () => {
						throw new Error('Vitess: connection reset')
					},
				},
				target: PROD,
				entries: [outboxEntryForEvent(event('k'), 'live')],
				reason: 'x',
				now: NOW,
				log: log(),
			}),
		).rejects.toThrow('Vitess')
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

	it('holds a row older than 24 hours for a human, unposted, and alerts', async () => {
		const stale = row({
			body: event('old', { occurredAt: minutesAgo(24 * 60 + 1) }),
		})
		stale.occurredAt = stale.body.occurredAt
		const { store, rows } = memoryStore([stale])
		const post = vi.fn()
		const { run } = replay(store, post)
		const receipt = await run
		expect(post).not.toHaveBeenCalled()
		expect(receipt.held).toBe(1)
		expect(receipt.alert).toContain('held')
		expect(receipt.depth.held).toBe(1)
		expect(rows.get(stale.id)?.status).toBe('held')
	})

	it('replays a row of up to 24 hours automatically', async () => {
		const young = row({
			body: event('young', { occurredAt: minutesAgo(24 * 60 - 1) }),
		})
		young.occurredAt = young.body.occurredAt
		const { store } = memoryStore([young])
		const post = vi.fn(async () => ({ kind: 'delivered' as const }))
		await replay(store, post).run
		expect(post).toHaveBeenCalledOnce()
	})

	it('posts a released held row despite its age', async () => {
		const released = row({
			body: event('old', { occurredAt: minutesAgo(3 * 24 * 60) }),
			releasedAt: minutesAgo(5),
		})
		released.occurredAt = released.body.occurredAt
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
