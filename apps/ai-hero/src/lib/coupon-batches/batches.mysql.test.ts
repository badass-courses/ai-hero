import { randomUUID } from 'node:crypto'
import * as schema from '@/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import type { Pool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	COUPON_BATCH_MINT_SCOPE,
	COUPON_BATCH_READ_SCOPE,
	createPersonalAccessToken,
	MintPersonalAccessTokenSchema,
} from '../personal-access-tokens'
import { couponBatchHandlers } from './http'
import { CONTROL_ID, createCouponBatchService, pacificDay } from './service'
import {
	concurrentlyBehindRowLock,
	createCouponFixturePool,
} from './mysql-fixture'
import { createCouponBatchWorkerPool } from './worker-pool'

const uri = process.env.AIH_COUPON_BATCH_MYSQL_URL
const run = randomUUID().slice(0, 8)
const tokenSecret = 'test-only-pat-secret'
const capture = (
	name: string,
	options: Parameters<typeof createPersonalAccessToken>[0]['scopes'],
	expiresAt: Date | null = new Date('2037-12-20T12:00:00Z'),
) =>
	createPersonalAccessToken({
		userId: `${name}-${run}`,
		name,
		scopes: options,
		expiresAt,
		hashSecret: tokenSecret,
	})
const operator = capture('operator', [
	COUPON_BATCH_MINT_SCOPE,
	COUPON_BATCH_READ_SCOPE,
])
const secondOperator = capture('second', [
	COUPON_BATCH_MINT_SCOPE,
	COUPON_BATCH_READ_SCOPE,
])
const readOnly = capture('reader', [COUPON_BATCH_READ_SCOPE])
const ungranted = capture('no-grant', [
	COUPON_BATCH_MINT_SCOPE,
	COUPON_BATCH_READ_SCOPE,
])
const content = capture('content', ['content:write'])
const noExpiry = capture('no-expiry', [COUPON_BATCH_MINT_SCOPE], null)
const deadlineAt = '2026-12-01T01:00:00Z'
const template = {
	productId: 'product-s00zs',
	percentageDiscount: 1,
	maxUses: 1,
	deadlineAt,
}
const payload = (label: string, count = 1) => ({
	campaignRef: `${run}-${label}`,
	templateId: 'c5-comp-v1',
	template,
	items: Array.from({ length: count }, (_, i) => ({
		intentKey: `${run}-${label}-${i}`,
	})),
})
const request = (
	value: unknown,
	id?: string,
	token: string | null = operator.rawToken,
) =>
	new Request('https://example.test/api/commerce/coupon-batches', {
		method: value === undefined ? 'GET' : 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(id ? { 'Idempotency-Key': id } : {}),
		},
		...(value === undefined ? {} : { body: JSON.stringify(value) }),
	})

it('does not let self-service token minting grant commerce scopes', () => {
	expect(
		MintPersonalAccessTokenSchema.safeParse({
			name: 'fixture',
			scopes: [COUPON_BATCH_MINT_SCOPE],
		}).success,
	).toBe(false)
})

describe.skipIf(!uri)(
	'desk coupon batches over HTTP with synthetic MySQL',
	() => {
		let pool: Pool
		let db: typeof import('@/db/client').db
		let service: ReturnType<typeof createCouponBatchService>
		let api: ReturnType<typeof couponBatchHandlers>
		let clock = new Date('2026-11-27T07:59:50Z')
		let firstDay: string
		let nextDay: string
		let rolloverAt: number
		let envEnabled = false
		const wake = vi.fn()
		const page = vi.fn(async (_value: unknown) => {})
		const log = vi.fn(async (_value: unknown) => {})

		beforeAll(async () => {
			const url = new URL(uri!)
			if (
				url.protocol !== 'mysql:' ||
				url.hostname !== '127.0.0.1' ||
				!/^\/coupon_batch_fixture(?:_[a-z0-9]+)?$/.test(url.pathname)
			)
				throw new Error('unsafe fixture database')
			pool = createCouponFixturePool(uri!)
			db = drizzle(pool, {
				schema,
				mode: 'planetscale',
			}) as unknown as typeof db
			// Repeat runs share the fixture DB but never reuse another wave's days.
			for (let attempt = 0; attempt < 460; attempt++) {
				const week = (Number.parseInt(run, 16) + attempt) % 460
				const midnightCandidates = [7, 8].map((hour) =>
					Date.UTC(2027, 0, 1 + 7 * week, hour),
				)
				const midnight = midnightCandidates.find(
					(t) => pacificDay(new Date(t)) !== pacificDay(new Date(t - 1000)),
				)!
				rolloverAt = midnight
				clock = new Date(midnight - 10_000)
				firstDay = pacificDay(clock)
				nextDay = pacificDay(new Date(midnight))
				const used = await db
					.select({ day: schema.couponBatchDay.day })
					.from(schema.couponBatchDay)
					.where(inArray(schema.couponBatchDay.day, [firstDay, nextDay]))
				if (used.length === 0) break
				if (attempt === 459) throw new Error('no unused synthetic Pacific day')
			}
			template.deadlineAt = new Date(+clock + 4 * 86400_000).toISOString()
			await db
				.insert(schema.couponBatchControl)
				.values({ id: CONTROL_ID, enabled: 0, paceMs: 0 })
				.onDuplicateKeyUpdate({
					set: { enabled: 0, paceMs: 0, chunkSize: 100, nextChunkAt: null },
				})
			await db
				.insert(schema.personalAccessToken)
				.values(
					[
						operator,
						secondOperator,
						readOnly,
						ungranted,
						content,
						noExpiry,
					].map((c) => c.record),
				)
			await db.insert(schema.couponBatchGrant).values(
				[operator, secondOperator, readOnly, content, noExpiry].map(
					({ record }) => ({
						principalId: record.userId,
						canMint: Number(record.userId !== readOnly.record.userId),
						canRead: 1,
					}),
				),
			)
			service = createCouponBatchService({
				db,
				enabled: () => envEnabled,
				patSecret: () => tokenSecret,
				batchSecret: () => 'synthetic-export-secret',
				now: () => clock,
			})
			api = couponBatchHandlers(() => service, wake)
		})
		afterAll(async () => {
			await pool?.end()
		})

		async function setControl(
			fields: Partial<typeof schema.couponBatchControl.$inferInsert>,
		) {
			await db
				.update(schema.couponBatchControl)
				.set(fields)
				.where(eq(schema.couponBatchControl.id, CONTROL_ID))
		}
		async function counts() {
			const [a] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.couponBatch)
				.where(eq(schema.couponBatch.principalId, operator.record.userId))
			const [b] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.couponBatchIntent)
				.where(eq(schema.couponBatchIntent.principalId, operator.record.userId))
			return [Number(a!.count), Number(b!.count)]
		}
		async function confirm(body: ReturnType<typeof payload>) {
			const preview = await api.preview(request(body))
			expect(preview.status).toBe(200)
			const { previewReceipt } = await preview.json()
			return { ...body, previewReceipt }
		}

		it('fails closed, admits no write on preview, and refuses stale or changed receipts', async () => {
			const b = payload('guards')
			const before = await counts()
			expect((await api.preview(request(b))).status).toBe(503)
			envEnabled = true
			expect((await api.preview(request(b))).status).toBe(503)
			await setControl({ enabled: 1 })
			for (const token of [
				null,
				'drovr-fixture-token',
				ungranted.rawToken,
				content.rawToken,
				noExpiry.rawToken,
				readOnly.rawToken,
			]) {
				expect((await api.preview(request(b, undefined, token))).status).toBe(
					401,
				)
				expect(
					(await api.submit(request(b, 'unauthorized', token))).status,
				).toBe(401)
			}
			for (const template of [
				{ ...b.template, productId: 'not-c5' },
				{ ...b.template, percentageDiscount: 0.5 },
				{ ...b.template, productId: '' },
				{ ...b.template, default: true },
				{ ...b.template, bypassSoldOut: true },
			]) {
				expect((await api.preview(request({ ...b, template }))).status).toBe(
					400,
				)
				expect(
					(await api.submit(request({ ...b, template }, 'wrong-template')))
						.status,
				).toBe(400)
			}
			const duplicate = await api.preview(
				request({ ...b, items: [b.items[0], b.items[0]] }),
			)
			expect(duplicate.status).toBe(400)
			expect(await duplicate.json()).toHaveProperty(
				'title',
				'duplicate_intent_key',
			)
			const ready = await confirm(b)
			expect(await counts()).toEqual(before)
			expect(
				(
					await api.submit(
						request({ ...ready, items: [{ intentKey: 'changed' }] }, 'changed'),
					)
				).status,
			).toBe(409)
			expect(
				(
					await api.submit(
						request(ready, 'cross-preview', secondOperator.rawToken),
					)
				).status,
			).toBe(409)
			expect(
				(
					await api.submit(
						request(
							{
								...b,
								template: { ...template, deadlineAt: clock.toISOString() },
							},
							'expired',
						),
					)
				).status,
			).toBe(422)
			const saved = clock
			clock = new Date(+clock + 301_000)
			expect((await api.submit(request(ready, 'stale'))).status).toBe(409)
			clock = saved
			await setControl({ enabled: 0 })
			expect((await api.submit(request(ready, 'killed'))).status).toBe(503)
			expect(await counts()).toEqual(before)
			await setControl({ enabled: 1 })
		})

		it('survives a lost response and same-key race, scopes read/export, and dedupes overlapping intents', async () => {
			const before = await counts()
			const body = await confirm(payload('race'))
			const [a, b] = await concurrentlyBehindRowLock(
				pool,
				'SELECT id FROM AI_CouponBatchControl WHERE id = ? FOR UPDATE',
				CONTROL_ID,
				'AI_CouponBatchControl',
				() =>
					Promise.all([
						api.submit(request(body, `race-${run}`)),
						api.submit(request(body, `race-${run}`)),
					]),
			)
			expect(a.status).toBe(202)
			expect(b.status).toBe(202)
			const original = await a.json()
			expect((await b.json()).batchId).toBe(original.batchId)
			expect(await counts()).toEqual([before[0]! + 1, before[1]!])
			await setControl({ enabled: 0 })
			expect(await service.runChunk()).toEqual({ state: 'paused' })
			await setControl({ enabled: 1 })
			expect((await service.runChunk(original.batchId)).state).toBe('worked')
			const later = await api.submit(
				request({ ...body, previewReceipt: undefined }, `race-${run}`),
			)
			expect(later.status).toBe(200)
			const status = await later.json()
			expect(status).toMatchObject({
				batchId: original.batchId,
				counts: { minted: 1, queued: 0 },
			})
			expect(await counts()).toEqual([before[0]! + 1, before[1]! + 1])
			expect(
				(await api.submit(request(payload('conflict'), `race-${run}`))).status,
			).toBe(409)
			expect(
				(
					await api.status(
						request(undefined, undefined, secondOperator.rawToken),
						status.batchId,
					)
				).status,
			).toBe(404)
			expect(
				(
					await api.exportPage(
						request(
							{ batchId: status.batchId },
							undefined,
							secondOperator.rawToken,
						),
					)
				).status,
			).toBe(404)
			const exported = await api.exportPage(
				request({ batchId: status.batchId }),
			)
			expect(exported.headers.get('cache-control')).toBe('private, no-store')
			const {
				outcomes: [issued],
			} = await exported.json()
			expect(issued.code).toMatch(/^c5comp_[0-9a-f]{40}$/)
			expect(JSON.stringify(status)).not.toContain(issued.code)
			const [audit] = await db
				.select()
				.from(schema.couponBatch)
				.where(eq(schema.couponBatch.id, status.batchId))
			expect(JSON.stringify(audit)).not.toContain(issued.code)
			const [stored] = await db
				.select()
				.from(schema.coupon)
				.where(eq(schema.coupon.id, issued.couponRef))
			expect(stored).toMatchObject({
				merchantCouponId: null,
				default: false,
				fields: { couponBatchTemplate: 'c5-comp-v1', bypassSoldOut: true },
			})
			expect(stored!.code).not.toBe(issued.code)
			const replay = await api
				.submit(request(body, `overlap-${run}`))
				.then((r) => r.json())
			await service.runChunk(replay.batchId)
			const overlap = await api
				.status(request(undefined), replay.batchId)
				.then((r) => r.json())
			expect(overlap.outcomes[0].couponRef).toBe(issued.couponRef)
			const mixed = await confirm({
				...payload('changed-intent', 2),
				items: [body.items[0]!, { intentKey: `${run}-new-mixed` }],
			})
			const result = await api
				.submit(request(mixed, `mixed-${run}`))
				.then((r) => r.json())
			await service.runChunk(result.batchId)
			const mixedStatus = await api
				.status(request(undefined), result.batchId)
				.then((r) => r.json())
			expect(mixedStatus.outcomes).toMatchObject([
				{ state: 'refused', reason: 'intent_conflict' },
				{ state: 'minted' },
			])
		})

		it('the DB releases a dropped worker transaction so the kill switch can commit', async () => {
			const isolated = createCouponBatchWorkerPool(uri!, 1)
			const worker = await isolated.getConnection()
			try {
				await worker.beginTransaction()
				await worker.query(
					'SELECT id FROM AI_CouponBatchControl WHERE id = ? FOR UPDATE',
					[CONTROL_ID],
				)
				// No client rollback, release or connection close until the switch commits.
				await setControl({ enabled: 0 })
				expect(await service.runChunk()).toEqual({ state: 'paused' })
			} finally {
				worker.destroy()
				await isolated.end()
				await setControl({ enabled: 1 })
			}
		})

		it('durably drains 3,058 with bounded chunks and alarms once across Pacific rollover', async () => {
			const large = await confirm(payload('wave', 3058))
			const rollover = await confirm(payload('old-day-second', 950))
			const a = await api.submit(request(large, `wave-${run}`))
			clock = new Date(+clock + 1)
			const b = await api.submit(request(rollover, `rollover-${run}`))
			expect(a.status).toBe(202)
			expect(b.status).toBe(202)
			const first = await a.json()
			const oldDay = await b.json()
			expect(first.counts).toEqual({
				total: 3058,
				minted: 0,
				refused: 0,
				queued: 3058,
			})
			expect(wake).toHaveBeenCalled()
			expect(
				(
					await api
						.lookup(
							request({
								intentKeys: [large.items[0]!.intentKey, `${run}-missing`],
							}),
						)
						.then((r) => r.json())
				).outcomes.map((r: { state: string }) => r.state),
			).toEqual(['pending', 'unknown'])
			await setControl({ enabled: 0, chunkSize: 50, paceMs: 500 })
			expect(await service.runChunk()).toEqual({ state: 'paused' })
			await setControl({ enabled: 1 })
			expect((await service.runChunk()).state).toBe('worked')
			expect((await service.runChunk()).state).toBe('paced')
			clock = new Date(rolloverAt + 1000)
			const after = await confirm(payload('new-day', 103))
			const next = await api
				.submit(request(after, `new-day-${run}`))
				.then((r) => r.json())
			for (let i = 0; i < 90; i++) {
				clock = new Date(+clock + 500)
				const result = await service.runChunk()
				if (result.state === 'idle') break
				expect(result.state).toBe('worked')
			}
			for (const [batchId, total] of [
				[first.batchId, 3058],
				[oldDay.batchId, 950],
				[next.batchId, 103],
			] as const) {
				expect(
					(await api.status(request(undefined), batchId).then((r) => r.json()))
						.counts,
				).toEqual({ total, minted: total, refused: 0, queued: 0 })
			}
			let cursor: number | null = 0
			let read = 0
			while (cursor !== null) {
				const req: Request = new Request(
					`https://example.test/?cursor=${cursor}`,
					{
						headers: { Authorization: `Bearer ${operator.rawToken}` },
					},
				)
				const status: { outcomes: unknown[]; nextCursor: number | null } =
					await api.status(req, first.batchId).then((r) => r.json())
				expect(status.outcomes.length).toBeLessThanOrEqual(100)
				read += status.outcomes.length
				cursor = status.nextCursor
			}
			expect(read).toBe(3058)
			const alarms = await db
				.select()
				.from(schema.couponBatchAlert)
				.where(
					and(
						eq(schema.couponBatchAlert.kind, 'request'),
						eq(schema.couponBatchAlert.batchId, first.batchId),
					),
				)
			expect(alarms).toHaveLength(1)
			const outage = vi
				.fn()
				.mockRejectedValue(new Error('synthetic pager failure'))
			await service.drainAlerts(outage, log)
			expect(outage).toHaveBeenCalledTimes(2)
			clock = new Date(+clock + 5000)
			await api.submit(request(large, `wave-${run}`))
			await service.drainAlerts(page, log)
			await service.drainAlerts(page, log)
			expect(
				log.mock.calls.map(([r]) => (r as { kind: string }).kind).sort(),
			).toEqual(['daily', 'request'])
			expect(page).toHaveBeenCalledTimes(2)
			const [late] = await db
				.select()
				.from(schema.couponBatch)
				.where(eq(schema.couponBatch.id, next.batchId))
			const [older] = await db
				.select()
				.from(schema.couponBatch)
				.where(eq(schema.couponBatch.id, oldDay.batchId))
			expect(older).toMatchObject({ acceptedDay: firstDay, dailyAlarm: 1 })
			expect(late).toMatchObject({ acceptedDay: nextDay, dailyAlarm: 0 })
		}, 45_000)

		it('rechecks an admitted credential and refuses remaining work without a second mint', async () => {
			await setControl({ paceMs: 0, chunkSize: 100, nextChunkAt: null })
			const body = await confirm(payload('revoked', 101))
			const submitted = await api.submit(request(body, `revoked-${run}`))
			const { batchId } = await submitted.json()
			expect(submitted.status).toBe(202)
			await db
				.update(schema.couponBatchGrant)
				.set({ canMint: 0 })
				.where(eq(schema.couponBatchGrant.principalId, operator.record.userId))
			expect((await service.runChunk()).state).toBe('worked')
			await db
				.update(schema.couponBatchGrant)
				.set({ canMint: 1 })
				.where(eq(schema.couponBatchGrant.principalId, operator.record.userId))
			await db
				.update(schema.personalAccessToken)
				.set({ revokedAt: clock })
				.where(eq(schema.personalAccessToken.id, operator.record.id))
			expect((await service.runChunk()).state).toBe('worked')
			await db
				.update(schema.personalAccessToken)
				.set({ revokedAt: null })
				.where(eq(schema.personalAccessToken.id, operator.record.id))
			const status = await api
				.status(request(undefined), batchId)
				.then((r) => r.json())
			expect(status.counts).toEqual({
				total: 101,
				minted: 0,
				queued: 0,
				refused: 101,
			})
			expect(
				status.outcomes.every(
					(r: { reason: string }) => r.reason === 'credential_revoked',
				),
			).toBe(true)
			const fresh = await api
				.submit(request(await confirm(body), `fresh-credential-${run}`))
				.then((r) => r.json())
			await service.runChunk(fresh.batchId)
			await service.runChunk(fresh.batchId)
			expect(
				await api
					.status(request(undefined), fresh.batchId)
					.then((r) => r.json()),
			).toMatchObject({
				counts: { minted: 101, refused: 0 },
			})
		})

		it('can re-admit keys refused by a deadline or policy change', async () => {
			for (const reason of ['deadline_passed', 'policy_changed'] as const) {
				const body = payload(reason)
				const { batchId } = await api
					.submit(request(await confirm(body), `first-${reason}-${run}`))
					.then((r) => r.json())
				await db
					.update(schema.couponBatch)
					.set(
						reason === 'deadline_passed'
							? { deadlineAt: new Date(+clock - 1000) }
							: { policyRevision: 'old-policy' },
					)
					.where(eq(schema.couponBatch.id, batchId))
				expect((await service.runChunk(batchId)).state).toBe('worked')
				expect(
					await api.status(request(undefined), batchId).then((r) => r.json()),
				).toMatchObject({
					outcomes: [{ state: 'refused', reason }],
				})
				const renewed = await api
					.submit(request(await confirm(body), `fresh-${reason}-${run}`))
					.then((r) => r.json())
				expect((await service.runChunk(renewed.batchId)).state).toBe('worked')
				expect(
					await api
						.status(request(undefined), renewed.batchId)
						.then((r) => r.json()),
				).toMatchObject({
					outcomes: [{ state: 'minted' }],
				})
			}
		})

		it('stops before minting a code whose export window has elapsed', async () => {
			const body = payload('abandoned-export')
			const { batchId } = await api
				.submit(request(await confirm(body), `abandoned-${run}`))
				.then((r) => r.json())
			clock = new Date(+clock + 24 * 3600_000)
			expect((await service.runChunk(batchId)).state).toBe('worked')
			expect(
				await api.status(request(undefined), batchId).then((r) => r.json()),
			).toMatchObject({
				counts: { minted: 0, refused: 1 },
				outcomes: [{ reason: 'export_window_elapsed' }],
			})
			expect((await api.exportPage(request({ batchId }))).status).toBe(410)
			const renewed = await api
				.submit(request(await confirm(body), `renewed-${run}`))
				.then((r) => r.json())
			await service.runChunk(renewed.batchId)
			expect(
				await api
					.exportPage(request({ batchId: renewed.batchId }))
					.then((r) => r.json()),
			).toMatchObject({
				outcomes: [{ state: 'minted', code: expect.any(String) }],
			})
		})

		it('exports committed codes while stopped or parked and writes aging and stuck alarms once', async () => {
			await setControl({ chunkSize: 1, paceMs: 0, nextChunkAt: null })
			const { batchId } = await api
				.submit(
					request(
						await confirm(payload('invalid-fixture-chunk', 2)),
						`bad-chunk-${run}`,
					),
				)
				.then((r) => r.json())
			expect((await service.runChunk(batchId)).state).toBe('worked')
			expect((await api.exportPage(request({ batchId }))).status).toBe(409)
			await setControl({ enabled: 0 })
			const stopped = await api
				.exportPage(request({ batchId }))
				.then((r) => r.json())
			expect(stopped.outcomes[0]).toMatchObject({
				state: 'minted',
				code: expect.any(String),
			})
			expect(stopped.outcomes[1]).not.toHaveProperty('code')
			await setControl({ enabled: 1 })
			await db
				.delete(schema.couponBatchItem)
				.where(
					and(
						eq(schema.couponBatchItem.batchId, batchId),
						eq(schema.couponBatchItem.ordinal, 2),
					),
				)
			for (let attempt = 1; attempt <= 8; attempt++) {
				expect(await service.runChunk(batchId)).toEqual({
					state: 'retry',
					reason: 'manifest_inconsistent',
					attempts: attempt,
				})
				clock = new Date(+clock + 65_000)
			}
			clock = new Date(+clock + 30 * 60_000)
			expect(await service.runChunk(batchId)).toEqual({ state: 'idle' })
			const parked = await api
				.exportPage(request({ batchId }))
				.then((r) => r.json())
			expect(parked.outcomes).toEqual([stopped.outcomes[0]])
			await setControl({ chunkSize: 100 })
			const sent = vi.fn(async (_row: unknown) => {})
			await service.drainAlerts(sent, log)
			await service.drainAlerts(sent, log)
			expect(
				sent.mock.calls
					.map(([value]) => (value as { kind: string }).kind)
					.sort(),
			).toEqual(['aging', 'stuck'])
		})

		it('overlap keeps the terminal result but cannot renew its code export window', async () => {
			const body = payload('export-window')
			const original = await api
				.submit(request(await confirm(body), `original-${run}`))
				.then((r) => r.json())
			await service.runChunk(original.batchId)
			const from = await api.exportPage(request({ batchId: original.batchId }))
			const issued = (await from.json()).outcomes[0]
			expect(issued).toHaveProperty('code')
			clock = new Date(+clock + 24 * 3600_000 + 1000)
			expect(
				(await api.exportPage(request({ batchId: original.batchId }))).status,
			).toBe(410)
			const another = await api
				.submit(request(await confirm(body), `another-${run}`))
				.then((r) => r.json())
			await service.runChunk(another.batchId)
			const next = await api
				.exportPage(request({ batchId: another.batchId }))
				.then((r) => r.json())
			expect(next.outcomes[0]).toMatchObject({
				state: 'minted',
				couponRef: issued.couponRef,
			})
			expect(next.outcomes[0]).not.toHaveProperty('code')
		})
	},
)
