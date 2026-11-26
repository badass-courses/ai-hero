import { randomUUID } from 'node:crypto'
import type { DbExecutor, DbTransaction } from '@/db/client'
import { mysqlTable } from '@/db/mysql-table'
import {
	couponBatch as batch,
	couponBatchAlert as alert,
	couponBatchControl as control,
	couponBatchDay as day,
	couponBatchGrant as grant,
	couponBatchIntent as intent,
	couponBatchItem as item,
	personalAccessToken as pat,
} from '@/db/schema'
import {
	COUPON_BATCH_MINT_SCOPE,
	COUPON_BATCH_READ_SCOPE,
	parsePersonalAccessToken,
	verifyPersonalAccessToken,
	type CouponBatchScope,
} from '@/lib/personal-access-tokens'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import {
	requireCouponBatchInsert,
	type CouponInsertRow,
} from '@coursebuilder/core/ports'
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import {
	BatchProblem,
	checkDeadline,
	confirmPreview,
	DAILY_ALARM,
	EXPORT_MS,
	issuePreview,
	PAGE,
	POLICY_REVISION,
	PRODUCT,
	REQUEST_ALARM,
	sha,
	TEMPLATE,
	type Manifest,
} from './contract'
import {
	newSelector,
	openSelector,
	ROW_PREFIX,
	sealSelector,
	selectorDigest,
} from './selector'

export const CONTROL_ID = 'ai-hero'
export const INLINE_MS = 5_000
const exportOrRead = COUPON_BATCH_READ_SCOPE
const mintScope = COUPON_BATCH_MINT_SCOPE
const pacific = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/Los_Angeles',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
})
export function pacificDay(now: Date) {
	const parts = Object.fromEntries(
		pacific.formatToParts(now).map(({ type, value }) => [type, value]),
	)
	return `${parts.year}-${parts.month}-${parts.day}`
}

type Batch = typeof batch.$inferSelect
type Item = typeof item.$inferSelect
type Intent = typeof intent.$inferSelect
type Credential = typeof pat.$inferSelect
export type Alert = typeof alert.$inferSelect
export type ServiceOptions = {
	db: typeof import('@/db/client').db
	enabled: () => boolean
	patSecret: () => string | undefined
	batchSecret: () => string | undefined
	/** Synthetic fixture clock; production always reads the MySQL clock. */
	now?: () => Date
}
const safeProblem = (status: number, code: string): never => {
	throw new BatchProblem(status, code)
}
const batchIdFor = (actor: string, requestKey: string) =>
	`cb_${sha(JSON.stringify([actor, requestKey]))}`
const intentIdFor = (key: string) => sha(JSON.stringify(['desk-c5', key]))
const sameIntent = (
	b: Pick<Batch, 'principalId' | 'itemFingerprint'>,
	i: Intent,
) => b.principalId === i.principalId && b.itemFingerprint === i.fingerprint
const delay = (attempts: number) =>
	Math.min(60_000, 500 * 2 ** Math.min(attempts, 7)) +
	Math.floor(Math.random() * 250)

export function createCouponBatchService(options: ServiceOptions) {
	const { db } = options
	const secret = () =>
		options.batchSecret() || safeProblem(503, 'coupon_batch_unavailable')

	async function now(tx: DbExecutor) {
		if (options.now) return options.now()
		const [row] = await tx
			.select({
				t: sql<string>`DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`,
			})
			.from(control)
			.where(eq(control.id, CONTROL_ID))
		if (!row) return safeProblem(503, 'coupon_batch_unavailable')
		return new Date(row.t)
	}

	async function fence(tx: DbExecutor, lock: boolean) {
		if (!options.enabled()) return safeProblem(503, 'coupon_batch_paused')
		const query = tx.select().from(control).where(eq(control.id, CONTROL_ID))
		const [row] = lock ? await query.for('update') : await query
		if (row?.enabled !== 1) return safeProblem(503, 'coupon_batch_paused')
		return row
	}

	async function hasGrant(
		tx: DbExecutor,
		token: Credential,
		scope: CouponBatchScope,
		when: Date,
		lock: boolean,
	) {
		if (
			token.revokedAt ||
			!token.expiresAt ||
			token.expiresAt <= when ||
			!token.scopes.includes(scope)
		)
			return false
		const query = tx
			.select()
			.from(grant)
			.where(eq(grant.principalId, token.userId))
		const [row] = lock ? await query.for('update') : await query
		return scope === mintScope ? row?.canMint === 1 : row?.canRead === 1
	}

	async function authenticate(
		tx: DbExecutor,
		raw: string,
		scope: CouponBatchScope,
		when: Date,
		lock = false,
	) {
		const parsed = parsePersonalAccessToken(raw)
		const hashSecret = options.patSecret()
		if (!parsed || !hashSecret)
			return safeProblem(401, 'coupon_batch_unauthorized')
		const query = tx.select().from(pat).where(eq(pat.publicId, parsed.publicId))
		const [token] = lock ? await query.for('update') : await query
		if (
			!token ||
			!verifyPersonalAccessToken({
				rawToken: raw,
				record: token,
				requiredScope: scope,
				hashSecret,
				now: when,
			}).ok ||
			!(await hasGrant(tx, token, scope, when, lock))
		) {
			return safeProblem(401, 'coupon_batch_unauthorized')
		}
		return token
	}

	async function authorize(raw: string, scope: CouponBatchScope) {
		// Reject non-PAT callers without parsing or spooling their bodies.
		if (!parsePersonalAccessToken(raw))
			safeProblem(401, 'coupon_batch_unauthorized')
		if (scope === mintScope) await fence(db, false)
		await authenticate(db, raw, scope, await now(db))
	}

	async function preview(raw: string, manifest: Manifest) {
		await fence(db, false)
		const when = await now(db)
		const token = await authenticate(db, raw, mintScope, when)
		checkDeadline(manifest.terms.deadlineAt, when)
		let eligible = 0,
			refused = 0
		const outcomes: { intentKey: string; state: string; reason?: string }[] = []
		for await (const page of manifest.pages()) {
			const known = await db
				.select({
					id: intent.id,
					principalId: intent.principalId,
					fingerprint: intent.fingerprint,
					refused: intent.refused,
				})
				.from(intent)
				.where(inArray(intent.id, page.map(intentIdFor)))
			const entries = new Map(known.map((r) => [r.id, r]))
			for (const intentKey of page) {
				const row = entries.get(intentIdFor(intentKey))
				const reason =
					row &&
					(row.principalId !== token.userId ||
					row.fingerprint !== manifest.itemFingerprint
						? 'intent_conflict'
						: row.refused)
				if (reason) refused++
				else eligible++
				if (outcomes.length < PAGE)
					outcomes.push(
						reason
							? { intentKey, state: 'refused', reason }
							: { intentKey, state: 'eligible' },
					)
			}
		}
		return {
			templateId: TEMPLATE,
			template: manifest.terms,
			eligible,
			refused,
			outcomes,
			outcomesTruncated: manifest.total > PAGE,
			previewReceipt: issuePreview(
				token.userId,
				manifest.fingerprint,
				when,
				secret(),
			),
		}
	}

	async function admit(raw: string, requestKey: string, manifest: Manifest) {
		return db.transaction(async (tx) => {
			await fence(tx, true)
			const token = await authenticate(tx, raw, mintScope, await now(tx), true)
			const when = await now(tx)
			if (!token.expiresAt || token.expiresAt <= when)
				return safeProblem(401, 'coupon_batch_unauthorized')
			const batchId = batchIdFor(token.userId, requestKey)
			const [previous] = await tx
				.select()
				.from(batch)
				.where(eq(batch.id, batchId))
			if (previous) {
				if (previous.fingerprint !== manifest.fingerprint)
					return safeProblem(409, 'request_conflict')
				return { batchId, principalId: token.userId, initialStatus: null }
			}
			checkDeadline(manifest.terms.deadlineAt, when)
			confirmPreview(
				manifest.previewReceipt,
				token.userId,
				manifest.fingerprint,
				when,
				secret(),
			)
			const requestAlarm = Number(manifest.total > REQUEST_ALARM)
			const acceptedDay = pacificDay(when)
			const [counter] = await tx
				.select()
				.from(day)
				.where(eq(day.day, acceptedDay))
			await tx.insert(batch).values({
				id: batchId,
				principalId: token.userId,
				credentialId: token.id,
				requestKey: sha(requestKey),
				fingerprint: manifest.fingerprint,
				itemFingerprint: manifest.itemFingerprint,
				campaignHash: sha(manifest.campaignRef),
				templateId: TEMPLATE,
				policyRevision: POLICY_REVISION,
				deadlineAt: new Date(manifest.terms.deadlineAt),
				acceptedAt: when,
				acceptedDay,
				exportUntil: new Date(+when + EXPORT_MS),
				total: manifest.total,
				nextAttemptAt: when,
				requestAlarm,
				dailyAlarm: Number((counter?.intents ?? 0) > DAILY_ALARM),
			})
			let ordinal = 0
			const outcomes: { intentKey: string; state: 'queued' }[] = []
			for await (const page of manifest.pages()) {
				if (!ordinal)
					outcomes.push(
						...page.map((intentKey) => ({
							intentKey,
							state: 'queued' as const,
						})),
					)
				await tx.insert(item).values(
					page.map((intentKey) => ({
						batchId,
						ordinal: ++ordinal,
						intentKey,
						intentId: intentIdFor(intentKey),
					})),
				)
			}
			if (requestAlarm)
				await tx.insert(alert).values({
					id: `request:${batchId}`,
					batchId,
					kind: 'request',
					count: ordinal,
					threshold: REQUEST_ALARM,
					nextAttemptAt: when,
				})
			return {
				batchId,
				principalId: token.userId,
				initialStatus: {
					batchId,
					templateId: TEMPLATE,
					state: 'queued',
					counts: { total: ordinal, queued: ordinal, minted: 0, refused: 0 },
					outcomes,
					nextCursor: ordinal > PAGE ? PAGE : null,
				},
			}
		})
	}

	async function mintChunk(
		tx: DbTransaction,
		fresh: Map<string, Intent>,
		deadline: Date,
	) {
		if (!fresh.size) return
		const insert = requireCouponBatchInsert(
			DrizzleAdapter<MySqlDatabase<any, any, any>>(tx, mysqlTable),
		)
		const pending = [...fresh.values()].filter((i) => !i.refused)
		if (!pending.length) return
		const batchSecret = secret()
		const candidate = (i: Intent) => {
			const couponRef = `${ROW_PREFIX}${randomUUID()}`
			const code = newSelector()
			i.couponRef = couponRef
			i.sealedCode = sealSelector(code, batchSecret, couponRef)
			const row: CouponInsertRow = {
				id: couponRef,
				code: selectorDigest(code),
				merchantCouponId: null,
				restrictedToProductId: PRODUCT,
				percentageDiscount: '1.00',
				expires: deadline,
				maxUses: 1,
				usedCount: 0,
				status: 1,
				default: false,
				fields: { couponBatchTemplate: TEMPLATE, bypassSoldOut: true },
			}
			return { i, row }
		}
		const isCollision = (err: unknown) =>
			typeof err === 'object' &&
			err !== null &&
			'code' in err &&
			err.code === 'COUPON_SELECTOR_COLLISION'
		async function isolated(rows: ReturnType<typeof candidate>[]) {
			try {
				await insert(rows.map(({ row }) => row))
			} catch (error) {
				if (!isCollision(error)) throw error
				if (rows.length > 1) {
					const half = Math.ceil(rows.length / 2)
					await isolated(rows.slice(0, half))
					await isolated(rows.slice(half))
					return
				}
				for (let attempt = 0; attempt < 3; attempt++) {
					const { row } = candidate(rows[0]!.i)
					try {
						await insert([row])
						return
					} catch (retry) {
						if (!isCollision(retry)) throw retry
					}
				}
				Object.assign(rows[0]!.i, {
					couponRef: null,
					sealedCode: null,
					refused: 'selector_collision',
				})
			}
		}
		await isolated(pending.map((i) => candidate(i)))
	}

	async function runChunk(onlyBatch?: string) {
		let workingBatch: Pick<Batch, 'id' | 'processed' | 'attempts'> | undefined
		try {
			return await db.transaction(async (tx) => {
				const cfg = await fence(tx, true)
				const when = await now(tx)
				if (cfg.nextChunkAt && cfg.nextChunkAt > when)
					return { state: 'paced' as const, waitMs: +cfg.nextChunkAt - +when }
				const [b] = await tx
					.select()
					.from(batch)
					.where(
						and(
							isNull(batch.finishedAt),
							lte(batch.nextAttemptAt, when),
							onlyBatch ? eq(batch.id, onlyBatch) : undefined,
						),
					)
					.orderBy(asc(batch.acceptedAt), asc(batch.id))
					.limit(1)
					.for('update')
				if (!b) return { state: 'idle' as const }
				workingBatch = b
				const chunkSize = Math.max(1, Math.min(PAGE, cfg.chunkSize))
				const chunk = await tx
					.select()
					.from(item)
					.where(and(eq(item.batchId, b.id), gt(item.ordinal, b.processed)))
					.orderBy(item.ordinal)
					.limit(chunkSize)
				if (!chunk.length) throw new Error('missing_manifest_chunk')
				const [token] = await tx
					.select()
					.from(pat)
					.where(eq(pat.id, b.credentialId))
					.for('update')
				const allowed =
					token?.userId === b.principalId &&
					(await hasGrant(tx, token, mintScope, when, true))
				const mintTime = await now(tx)
				let policyRefusal: string | null =
					!allowed || !token?.expiresAt || token.expiresAt <= mintTime
						? 'credential_revoked'
						: b.policyRevision !== POLICY_REVISION || b.templateId !== TEMPLATE
							? 'policy_changed'
							: null
				if (!policyRefusal) {
					try {
						checkDeadline(b.deadlineAt.toISOString(), mintTime)
					} catch {
						policyRefusal = 'deadline_passed'
					}
				}
				const known = await tx
					.select()
					.from(intent)
					.where(
						inArray(
							intent.id,
							chunk.map((i) => i.intentId),
						),
					)
				const entries = new Map(known.map((i) => [i.id, i]))
				const fresh = new Map<string, Intent>()
				for (const row of chunk) {
					if (entries.has(row.intentId) || fresh.has(row.intentId)) continue
					fresh.set(row.intentId, {
						id: row.intentId,
						principalId: b.principalId,
						fingerprint: b.itemFingerprint,
						couponRef: null,
						sealedCode: null,
						expiresAt: b.deadlineAt,
						exportUntil: b.exportUntil,
						refused: policyRefusal,
					})
				}
				await mintChunk(tx, fresh, b.deadlineAt)
				if (fresh.size) await tx.insert(intent).values([...fresh.values()])
				let minted = 0
				const outcomes = chunk.map((row) => {
					const result = entries.get(row.intentId) ?? fresh.get(row.intentId)!
					const state = sameIntent(b, result)
						? (result.refused ?? 'minted')
						: 'intent_conflict'
					if (state === 'minted') minted++
					return { ...row, result: state }
				})
				await tx
					.insert(item)
					.values(outcomes)
					.onDuplicateKeyUpdate({
						set: { result: sql`VALUES(${item.result})` },
					})
				const newMints = [...fresh.values()].filter((i) => i.couponRef).length
				const [counter] = await tx
					.select()
					.from(day)
					.where(eq(day.day, b.acceptedDay))
				const count = (counter?.intents ?? 0) + fresh.size
				if (fresh.size)
					await tx
						.insert(day)
						.values({
							day: b.acceptedDay,
							intents: count,
							mints: (counter?.mints ?? 0) + newMints,
						})
						.onDuplicateKeyUpdate({
							set: { intents: count, mints: (counter?.mints ?? 0) + newMints },
						})
				if (count > DAILY_ALARM && (counter?.intents ?? 0) <= DAILY_ALARM) {
					await tx.insert(alert).values({
						id: `day:${b.acceptedDay}`,
						batchId: b.id,
						kind: 'daily',
						count,
						threshold: DAILY_ALARM,
						nextAttemptAt: when,
					})
				}
				const processed = b.processed + chunk.length
				await tx
					.update(batch)
					.set({
						processed,
						minted: b.minted + minted,
						refused: b.refused + chunk.length - minted,
						newIntents: b.newIntents + fresh.size,
						newMints: b.newMints + newMints,
						dailyAlarm: Number(count > DAILY_ALARM),
						attempts: 0,
						nextAttemptAt: when,
						finishedAt: processed === b.total ? when : null,
					})
					.where(eq(batch.id, b.id))
				await tx
					.update(control)
					.set({
						nextChunkAt: new Date(
							+(await now(tx)) + Math.max(0, Math.min(60_000, cfg.paceMs)),
						),
					})
					.where(eq(control.id, CONTROL_ID))
				return {
					state: 'worked' as const,
					finished: processed === b.total,
					batchId: b.id,
				}
			})
		} catch (error) {
			if (error instanceof BatchProblem && error.code === 'coupon_batch_paused')
				return { state: 'paused' as const }
			// No unknown DB error (which may include query parameters) leaves this
			// module. Record a backoff after checking that the cursor did not advance.
			if (workingBatch) await defer(workingBatch).catch(() => {})
			return { state: 'retry' as const }
		}
	}

	async function defer(observed: Pick<Batch, 'id' | 'processed' | 'attempts'>) {
		await db.transaction(async (tx) => {
			await fence(tx, true)
			const [b] = await tx
				.select()
				.from(batch)
				.where(eq(batch.id, observed.id))
				.for('update')
			if (
				b &&
				!b.finishedAt &&
				b.processed === observed.processed &&
				b.attempts === observed.attempts
			) {
				await tx
					.update(batch)
					.set({
						attempts: b.attempts + 1,
						nextAttemptAt: new Date(+(await now(tx)) + delay(b.attempts)),
					})
					.where(eq(batch.id, b.id))
			}
		})
	}

	async function owner(tx: DbExecutor, batchId: string, principalId: string) {
		const [record] = await tx
			.select()
			.from(batch)
			.where(and(eq(batch.id, batchId), eq(batch.principalId, principalId)))
		return record ?? safeProblem(404, 'batch_not_found')
	}

	// Select only the public outcome fields on the readback path. No bearer,
	// ciphertext, or digest used by redemption is selected into status.
	const resultFields = {
		ordinal: item.ordinal,
		intentKey: item.intentKey,
		result: item.result,
		couponRef: intent.couponRef,
		expiresAt: intent.expiresAt,
	}
	const itemOutcome = (row: {
		intentKey: string
		result: Item['result']
		couponRef: Intent['couponRef']
		expiresAt: Date | null
	}) =>
		row.result === 'minted'
			? {
					intentKey: row.intentKey,
					state: 'minted',
					couponRef: row.couponRef,
					expiresAt: row.expiresAt,
				}
			: row.result
				? { intentKey: row.intentKey, state: 'refused', reason: row.result }
				: { intentKey: row.intentKey, state: 'queued' }

	async function statusFor(
		tx: DbExecutor,
		batchId: string,
		principalId: string,
		cursor = 0,
	) {
		const b = await owner(tx, batchId, principalId)
		const page = await tx
			.select(resultFields)
			.from(item)
			.leftJoin(
				intent,
				and(
					eq(intent.id, item.intentId),
					eq(intent.principalId, b.principalId),
					eq(intent.fingerprint, b.itemFingerprint),
				),
			)
			.where(and(eq(item.batchId, b.id), gt(item.ordinal, cursor)))
			.orderBy(item.ordinal)
			.limit(PAGE)
		return {
			batchId,
			templateId: b.templateId,
			state: b.finishedAt ? 'complete' : 'queued',
			counts: {
				total: b.total,
				minted: b.minted,
				refused: b.refused,
				queued: b.total - b.processed,
			},
			outcomes: page.map((row) =>
				b.attempts && !row.result
					? {
							intentKey: row.intentKey,
							state: 'retry',
							reason: 'worker_unavailable',
							retryAfter: b.nextAttemptAt,
						}
					: itemOutcome(row),
			),
			nextCursor:
				page.at(-1) && page.at(-1)!.ordinal < b.total
					? page.at(-1)!.ordinal
					: null,
		}
	}

	async function read<T>(
		raw: string,
		run: (tx: DbTransaction, token: Credential, when: Date) => Promise<T>,
	) {
		return db.transaction(async (tx) => {
			const when = await now(tx)
			const token = await authenticate(tx, raw, exportOrRead, when, true)
			return run(tx, token, when)
		})
	}

	async function exportPage(raw: string, batchId: string, cursor: number) {
		return read(raw, async (tx, token, when) => {
			const b = await owner(tx, batchId, token.userId)
			if (b.exportUntil <= when) return safeProblem(410, 'export_expired')
			if (!b.finishedAt) return safeProblem(409, 'batch_pending')
			const page = await tx
				.select({
					...resultFields,
					sealedCode: intent.sealedCode,
					exportUntil: intent.exportUntil,
				})
				.from(item)
				.leftJoin(
					intent,
					and(
						eq(intent.id, item.intentId),
						eq(intent.principalId, b.principalId),
						eq(intent.fingerprint, b.itemFingerprint),
					),
				)
				.where(and(eq(item.batchId, b.id), gt(item.ordinal, cursor)))
				.orderBy(item.ordinal)
				.limit(PAGE)
			return {
				batchId,
				nextCursor:
					page.at(-1) && page.at(-1)!.ordinal < b.total
						? page.at(-1)!.ordinal
						: null,
				outcomes: page.map((row) => ({
					...itemOutcome(row),
					...(row.result === 'minted' &&
					row.expiresAt &&
					row.expiresAt > when &&
					row.exportUntil &&
					row.exportUntil > when &&
					row.sealedCode &&
					row.couponRef
						? { code: openSelector(row.sealedCode, secret(), row.couponRef) }
						: {}),
				})),
			}
		})
	}

	async function lookup(raw: string, keys: string[]) {
		return read(raw, async (tx, token) => {
			const ids = keys.map(intentIdFor)
			const known = new Map(
				(
					await tx
						.select({
							id: intent.id,
							couponRef: intent.couponRef,
							expiresAt: intent.expiresAt,
							refused: intent.refused,
						})
						.from(intent)
						.where(
							and(
								inArray(intent.id, ids),
								eq(intent.principalId, token.userId),
							),
						)
				).map((row) => [row.id, row]),
			)
			const pending = new Set(
				(
					await tx
						.selectDistinct({ id: item.intentId })
						.from(item)
						.innerJoin(batch, eq(batch.id, item.batchId))
						.where(
							and(
								inArray(item.intentId, ids),
								eq(batch.principalId, token.userId),
								isNull(item.result),
							),
						)
				).map((r) => r.id),
			)
			return {
				outcomes: keys.map((intentKey, index) => {
					const id = ids[index]!
					const row = known.get(id)
					return row
						? itemOutcome({
								intentKey,
								result: row.refused ?? 'minted',
								couponRef: row.couponRef,
								expiresAt: row.expiresAt,
							})
						: { intentKey, state: pending.has(id) ? 'pending' : 'unknown' }
				}),
			}
		})
	}

	async function drainAlerts(
		send: (row: Alert) => Promise<void>,
		log: (row: Alert) => Promise<void>,
	) {
		const when = await now(db)
		const rows = await db
			.select()
			.from(alert)
			.where(and(isNull(alert.deliveredAt), lte(alert.nextAttemptAt, when)))
			.orderBy(alert.nextAttemptAt)
			.limit(10)
		for (const row of rows) {
			try {
				if (!row.loggedAt) {
					await log(row)
					await db
						.update(alert)
						.set({ loggedAt: when })
						.where(eq(alert.id, row.id))
				}
				await send(row)
				await db
					.update(alert)
					.set({ deliveredAt: when })
					.where(eq(alert.id, row.id))
			} catch {
				await db
					.update(alert)
					.set({
						attempts: row.attempts + 1,
						nextAttemptAt: new Date(+when + delay(row.attempts)),
					})
					.where(eq(alert.id, row.id))
			}
		}
		return rows.length
	}

	return {
		authorize,
		preview,
		admit,
		runChunk,
		drainAlerts,
		statusForSubmit: (id: string, actor: string) =>
			db.transaction((tx) => statusFor(tx, id, actor)),
		status: (raw: string, id: string, cursor: number) =>
			read(raw, (tx, token) => statusFor(tx, id, token.userId, cursor)),
		exportPage,
		lookup,
	}
}
