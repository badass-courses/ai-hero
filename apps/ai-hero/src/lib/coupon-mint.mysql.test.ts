import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { userSchema } from '@coursebuilder/core/schemas'
import { CourseBuilder } from '@coursebuilder/server/http'
import { getCouponForCode } from './coupon-display'
import { couponBatchHandlers } from './coupon-batches/http'
import { c5CompPresentation } from './coupon-batches/free-selector'
import { createAppCommerceAdapter } from '@/db/commerce-adapter'
import { createSessionAccessCache } from '@/server/session-access-cache'
import { withPrivateCompClaim } from './coupon-batches/free-claim-request'
import { CONTROL_ID, createCouponBatchService } from './coupon-batches/service'
import {
	COUPON_BATCH_MINT_SCOPE,
	COUPON_BATCH_READ_SCOPE,
	createPersonalAccessToken,
} from './personal-access-tokens'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import type { Pool } from 'mysql2/promise'
import {
	concurrentlyBehindRowLock,
	createCouponFixturePool,
} from './coupon-batches/mysql-fixture'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'

// Minting and redemption run for real against MySQL; only Stripe is a stub,
// and a 100% mint must never touch it.
const state = vi.hoisted(() => ({
	database: undefined as unknown,
	adapter: undefined as unknown,
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		flush: vi.fn(),
	},
}))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
	get courseBuilderAdapter() {
		return state.adapter
	},
	get rawCourseBuilderAdapter() {
		return state.adapter
	},
}))
vi.mock('@/server/logger', () => ({ log: state.logger }))
vi.mock('@coursebuilder/utils/logger', () => ({ logger: state.logger }))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://example.test' },
}))
vi.mock('@/config', () => ({ default: {} }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: async () => ({}) }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (
			_config: unknown,
			_trigger: unknown,
			handler: unknown,
		) => ({ handler }),
	},
}))
vi.mock('@/emails/live-office-hours-invitation', () => ({
	default: vi.fn(),
	generateICSAttachments: vi.fn(),
}))
vi.mock('@/emails/welcome-archive-email', () => ({ default: vi.fn() }))
vi.mock('@/emails/welcome-cohort-email-team', () => ({ default: vi.fn() }))
vi.mock('@/emails/welcome-workshop-email-team', () => ({ default: vi.fn() }))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: vi.fn(async () => {
		throw new Error('Email forbidden')
	}),
}))


import {
	listMintedCoupons,
	mintCoupons,
	type CouponMintDeps,
} from './coupon-mint'
import { drizzleCouponMintStore } from './coupon-mint-drizzle'
import { isMysqlDuplicateEntryError } from './mysql-primary-key-retry'

// A database prepared by `scripts/test-mysql.sh schema <db>`.
const uri = process.env.AIH_COUPON_MINT_MYSQL_URL
const suite = uri ? describe : describe.skip
afterEach(() => { vi.unstubAllEnvs() })

function assertLoopbackTestDatabase(raw: string): string {
	const url = new URL(raw)
	if (
		url.protocol !== 'mysql:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		['', '/mysql', '/sys'].includes(url.pathname)
	) {
		throw new Error('unsafe-coupon-mint-mysql-test-url')
	}
	return raw
}

const run = randomUUID().slice(0, 8)
const product = `product-c5-${run}`
const label = `friends-${run}`
const actor = { userId: `admin-${run}`, authMethod: 'device-token' }
const stripe = vi.fn(async (): Promise<string | null> => {
	throw new Error('Stripe forbidden')
})
const deps: CouponMintDeps = {
	store: drizzleCouponMintStore,
	createOrFindMerchantCoupon: stripe,
	isDuplicateEntryError: isMysqlDuplicateEntryError,
	idSecret: 'synthetic-id-secret',
	inviteUrl: (id) => `https://example.test?code=${id}`,
}

suite('coupon minting against real MySQL', () => {
	let pool: Pool
	let db: MySqlDatabase<any, any, typeof schema>
	let adapter: ReturnType<typeof createAppCommerceAdapter>
	const cacheData = new Map<string, unknown>()
	const accessCache = createSessionAccessCache({
		ttlSeconds: 60,
		getStore: async () => ({
			mget: async (...keys) => keys.map((key) => cacheData.get(key) ?? null),
			set: async (key, value) => cacheData.set(key, value),
			incr: async (key) => {
				const generation = Number(cacheData.get(key) ?? 0) + 1
				cacheData.set(key, generation)
				return generation
			},
			expire: async () => true,
			del: async (...keys) => keys.forEach((key) => cacheData.delete(key)),
		}),
	})
	const committedAtBust = new Set<string>()
	const bustUser = vi.fn(async (userId: string) => {
		// A separate SQL read at bust time must see the committed claim.
		if (
			await db.query.purchases.findFirst({
				where: (purchase, { eq }) => eq(purchase.userId, userId),
			})
		)
			committedAtBust.add(userId)
		await accessCache.bustUser(userId)
	})

	beforeAll(async () => {
		pool = createCouponFixturePool(assertLoopbackTestDatabase(uri!))
		db = drizzle(pool, { schema, mode: 'planetscale' }) as any
		state.database = db
		adapter = createAppCommerceAdapter(
			db as unknown as typeof import('@/db/client').db,
			bustUser,
		)
		state.adapter = adapter
		await db.insert(schema.products).values({
			id: product,
			name: 'Synthetic C5',
			type: 'cohort',
			quantityAvailable: -1,
			status: 1,
			fields: { slug: `synthetic-c5-${run}`, state: 'published' },
		})
	})

	afterAll(async () => {
		await pool?.end()
	})

	it('mints the free batch shape once, even when the same key races', async () => {
		const request = {
			productId: product,
			percentageDiscount: 1,
			quantity: 2,
			label,
		}
		const idempotencyKey = `race-${run}-0000000000`
		const [a, b] = await Promise.all([
			mintCoupons({ actor, idempotencyKey, request }, deps),
			mintCoupons({ actor, idempotencyKey, request }, deps),
		])
		if (!('coupons' in a) || !('coupons' in b)) throw new Error('mint failed')
		expect([a.state, b.state].sort()).toEqual(['minted', 'replayed'])
		expect(b.coupons).toEqual(a.coupons)
		const replay = await mintCoupons({ actor, idempotencyKey, request }, deps)
		expect(replay).toMatchObject({ state: 'replayed', coupons: a.coupons })
		expect(stripe).not.toHaveBeenCalled()

		const rows = await db.query.coupon.findMany({
			where: inArray(
				schema.coupon.id,
				a.coupons.map((c) => c.id),
			),
		})
		expect(rows).toHaveLength(2)
		for (const row of rows)
			expect(row).toMatchObject({
				restrictedToProductId: product,
				percentageDiscount: '1.00',
				maxUses: 1,
				usedCount: 0,
				merchantCouponId: null,
				status: 1,
				default: false,
				code: null,
				expires: null,
				organizationId: null,
				fields: {
					bypassSoldOut: true,
					mintedFor: label,
					mintKey: expect.stringMatching(/^[0-9a-f]{64}$/),
					mintRequest: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
			})
		expect(rows.map((row) => row.fields?.mintIndex).sort()).toEqual([0, 1])

		// A smaller quantity on the same key must not replay a prefix.
		expect(
			await mintCoupons(
				{ actor, idempotencyKey, request: { ...request, quantity: 1 } },
				deps,
			),
		).toMatchObject({ state: 'conflict' })
		// Rotating the id secret still finds the stored batch through mintKey.
		expect(
			await mintCoupons(
				{ actor, idempotencyKey, request },
				{ ...deps, idSecret: 'synthetic-rotated-secret' },
			),
		).toMatchObject({ state: 'replayed', coupons: a.coupons })
	})

	it('redeems a minted 100% coupon through redeemFullPriceCoupon, once', async () => {
		const minted = await mintCoupons(
			{
				actor,
				idempotencyKey: `redeem-${run}-0000000000`,
				request: { productId: product, percentageDiscount: 1, label },
			},
			deps,
		)
		if (!('coupons' in minted)) throw new Error('mint failed')
		const couponId = minted.coupons[0]!.id
		const redeem = (email: string) =>
			adapter.redeemFullPriceCoupon({
				couponId,
				email,
				productIds: [product],
				redeemingProductId: product,
			})

		const result = await redeem(`friend-${run}@example.test`)
		expect(result?.purchase).toMatchObject({
			productId: product,
			couponId,
			redeemedBulkCouponId: null,
			status: 'Valid',
		})
		expect(Number(result!.purchase!.totalAmount)).toBe(0)
		const row = await db.query.coupon.findFirst({
			where: eq(schema.coupon.id, couponId),
		})
		expect(row?.usedCount).toBe(1)
		// maxUses 1: a second person cannot reuse the code.
		expect(await redeem(`stranger-${run}@example.test`)).toBeNull()

		const listed = await listMintedCoupons(
			{ productId: product, label },
			{ store: drizzleCouponMintStore, inviteUrl: deps.inviteUrl },
		)
		expect(listed.totals).toMatchObject({ coupons: 3, unused: 2, usedUp: 1 })
	})

	it('opens an exported C5 selector through the normal free claim and fulfills one C5 purchase', async () => {
		vi.stubEnv('AIH_COUPON_BATCH_ENABLED', 'true')
		const c5 = 'product-s00zs'
		const workshop = 'product-ma254'
		const fixtureAccount = {
			id: `comp-desk-${run}`,
			email: `comp-desk-${run}@example.test`,
		}
		const first = {
			id: `comp-student-${run}`,
			email: `comp-student-${run}@example.test`,
		}
		const second = {
			id: `comp-stranger-${run}`,
			email: `comp-stranger-${run}@example.test`,
		}
		await db.insert(schema.users).values([fixtureAccount, first, second])
		for (const user of [first, second]) {
			const organizationId = `personal-${user.id}`
			await db.insert(schema.organization).values({
				id: organizationId,
				name: `Personal ${user.email}`,
				personalOrganizationUserId: user.id,
			})
			await db.insert(schema.organizationMemberships).values({
				id: `member-${user.id}`,
				organizationId,
				userId: user.id,
				invitedById: user.id,
			})
		}
		await db
			.insert(schema.products)
			.values([
				{
					id: c5,
					name: 'Synthetic sold-out C5',
					type: 'cohort',
					quantityAvailable: 0,
					status: 1,
					fields: { slug: 'c5-fixture' },
				},
				{
					id: workshop,
					name: 'Synthetic included workshop',
					type: 'self-paced',
					status: 1,
					fields: { slug: 'workshop-fixture' },
				},
			])
			.onDuplicateKeyUpdate({ set: { status: 1 } })
		await db
			.insert(schema.contentResource)
			.values([
				{
					id: 'cohort-xdy1m',
					type: 'cohort',
					fields: { title: 'C5', slug: 'c5-fixture' },
					createdById: fixtureAccount.id,
				},
				{
					id: 'workshop-2ozd9',
					type: 'workshop',
					fields: { title: 'Synthetic C5 workshop', slug: 'fixture-c5-workshop', state: 'published' },
					createdById: fixtureAccount.id,
				},
			])
			.onDuplicateKeyUpdate({ set: { deletedAt: null, fields: sql`VALUES(${schema.contentResource.fields})` } })
		await db
			.insert(schema.contentResourceProduct)
			.values([
				{ productId: c5, resourceId: 'cohort-xdy1m' },
				{ productId: workshop, resourceId: 'workshop-2ozd9' },
			])
			.onDuplicateKeyUpdate({ set: { deletedAt: null } })
		await db.insert(schema.contentResourceResource).values({
			resourceOfId: 'cohort-xdy1m', resourceId: 'workshop-2ozd9', position: 0,
		}).onDuplicateKeyUpdate({ set: { deletedAt: null } })
		await db
			.insert(schema.entitlementTypes)
			.values([
				{
					id: 'coupon-test-cohort-access',
					name: 'cohort_content_access',
					description: 'C5 test',
				},
				{
					id: 'coupon-test-workshop-access',
					name: 'workshop_content_access',
					description: 'C5 bundle test',
				},
			])
			.onDuplicateKeyUpdate({ set: { description: 'Coupon fixture' } })
		const tokenSecret = 'synthetic-token-secret'
		const operator = createPersonalAccessToken({
			userId: fixtureAccount.id,
			name: 'test desk',
			scopes: [COUPON_BATCH_MINT_SCOPE, COUPON_BATCH_READ_SCOPE],
			hashSecret: tokenSecret,
			expiresAt: new Date(Date.now() + 3600_000),
		})
		await db.insert(schema.personalAccessToken).values(operator.record)
		await db
			.insert(schema.couponBatchGrant)
			.values({ principalId: operator.record.userId, canMint: 1, canRead: 1 })
		await db
			.insert(schema.couponBatchControl)
			.values({ id: CONTROL_ID, enabled: 1, claimsEnabled: 1, paceMs: 0 })
			.onDuplicateKeyUpdate({
				set: { enabled: 1, claimsEnabled: 1, paceMs: 0, nextChunkAt: null },
			})
		const service = createCouponBatchService({
			db: db as unknown as typeof import('@/db/client').db,
			enabled: () => true,
			patSecret: () => tokenSecret,
			batchSecret: () => 'synthetic-batch-secret',
		})
		const api = couponBatchHandlers(() => service, vi.fn())
		const request = (input: unknown) =>
			new Request('https://example.test/api/commerce/coupon-batches', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${operator.rawToken}`,
					'Idempotency-Key': `free-claim-${run}`,
				},
				body: JSON.stringify(input),
			})
		const body = {
			campaignRef: `claim-${run}`,
			templateId: 'c5-comp-v1',
			template: {
				productId: c5,
				percentageDiscount: 1,
				maxUses: 1,
				deadlineAt: new Date(
					Math.ceil(Date.now() / 1000) * 1000 + 300_000,
				).toISOString(),
			},
			items: [{ intentKey: `first-${run}` }, { intentKey: `expire-${run}` }],
		}
		const preview = await api.preview(request(body))
		expect(preview.status).toBe(200)
		const submitted = await api.submit(
			request({
				...body,
				previewReceipt: (await preview.json()).previewReceipt,
			}),
		)
		expect(submitted.status).toBe(202)
		const { batchId } = await submitted.json()
		expect((await service.runChunk(batchId)).state).toBe('worked')
		const exported = await api.exportPage(request({ batchId }))
		expect(exported.status).toBe(200)
		const [live, expired] = (await exported.json()).outcomes as {
			code: string
			couponRef: string
		}[]
		if (!live || !expired) throw new Error('missing synthetic selectors')
		const presentationDb = db as unknown as typeof import('@/db/client').db
		const opened = await getCouponForCode(
			live.code,
			[c5],
			c5CompPresentation(adapter, presentationDb, c5),
		)
		expect(opened).toMatchObject({
			isRedeemable: true,
			fields: { bypassSoldOut: true },
		})
		expect(
			await getCouponForCode(
				live.code,
				[workshop],
				c5CompPresentation(adapter, presentationDb, workshop),
			),
		).toBeUndefined()
		const rawLegacy = await mintCoupons(
			{
				actor,
				idempotencyKey: `legacy-claim-${run}-000000`,
				request: {
					productId: product,
					percentageDiscount: 1,
					label: `legacy-${run}`,
				},
			},
			deps,
		)
		if (!('coupons' in rawLegacy)) throw new Error('legacy fixture mint failed')
		expect(
			await getCouponForCode(rawLegacy.coupons[0]!.id, [product], adapter),
		).toMatchObject({ isRedeemable: true })

		const events: { name: string; data: { purchaseId: string } }[] = []
		const send = vi.fn(async (event: (typeof events)[number]) => {
			events.push(event)
			return { ids: [] }
		})
		const redeem = (couponId: string, email: string, productId = c5) =>
			withPrivateCompClaim(
				new Request('https://example.test/api/coursebuilder/redeem/coupon', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						couponId,
						email,
						productIds: [productId],
						sendEmail: false,
					}),
				}),
				(request) =>
					CourseBuilder(request, {
						baseUrl: 'https://example.test',
						basePath: '/api/coursebuilder',
						adapter,
						providers: [],
						authConfig: {} as never,
						getCurrentUser: async () => {
							const signedIn = [first, second].find((user) => user.email === email)
							return signedIn ? userSchema.parse(signedIn) : null
						},
						inngest: { send } as never,
						logger: state.logger,
					}),
			).then(async (response) => response.json())
		const setClaims = (claimsEnabled: number) => db.update(schema.couponBatchControl).set({ claimsEnabled }).where(eq(schema.couponBatchControl.id, CONTROL_ID))
		await setClaims(0)
		try {
			expect(await redeem(live.code, first.email)).toMatchObject({ purchase: null, error: { message: 'coupon-is-invalid' } })
			expect((await adapter.getCoupon(live.couponRef))?.usedCount).toBe(0)
			expect(events).toHaveLength(0)
		} finally {
			await setClaims(1)
		}
		await db
			.update(schema.coupon)
			.set({ expires: new Date(Date.now() - 60_000) })
			.where(eq(schema.coupon.id, expired.couponRef))
		await db.transaction(async (tx) => {
			await tx.execute(sql`SET SESSION time_zone = '+07:00'`)
			try {
				const display = c5CompPresentation(
					adapter,
					tx as unknown as typeof presentationDb,
					c5,
				)
				expect(await getCouponForCode(live.code, [c5], display)).toMatchObject({
					isRedeemable: true,
				})
				expect(
					await getCouponForCode(expired.code, [c5], display),
				).toBeUndefined()
				expect(
					await getCouponForCode(live.couponRef, [c5], display),
				).toBeUndefined()
			} finally {
				await tx.execute(sql`SET SESSION time_zone = '+00:00'`)
			}
		})
		const legacyAliasedId = `c5comp_${'f'.repeat(32)}${run}`
		await db.insert(schema.coupon).values({
			id: legacyAliasedId,
			percentageDiscount: '1.00',
			restrictedToProductId: c5,
			status: 1,
			maxUses: 1,
		})
		for (const denial of [
			await redeem(live.code, first.email, workshop),
			await redeem(expired.code, first.email),
			await redeem(legacyAliasedId, first.email),
		]) {
			expect(denial).toMatchObject({
				purchase: null,
				error: { message: 'coupon-is-invalid' },
			})
		}
		expect(await redeem(live.couponRef, first.email)).toBe(
			'invalid coupon request',
		)
		for (const claimant of [first, second]) {
			const token = `session-${claimant.id}`
			const miss = await accessCache.read(token, claimant.id)
			if (miss.status !== 'miss') throw new Error('expected unprimed session')
			await accessCache.write(token, claimant.id, miss, {
				roles: [
					{
						id: 'fixture-role',
						organizationId: null,
						name: 'user',
						description: null,
						active: true,
						createdAt: null,
						updatedAt: null,
						deletedAt: null,
					},
				],
				memberships: [
					{
						id: 'fixture-member',
						organizationId: 'fixture-org',
						createdAt: null,
					},
				],
				organizationRoles: [],
				discord: null,
			})
			expect((await accessCache.read(token, claimant.id)).status).toBe('hit')
		}
		const results = await concurrentlyBehindRowLock(
			pool,
			'SELECT id FROM AI_Coupon WHERE id = ? FOR UPDATE',
			live.couponRef,
			'AI_Coupon',
			() =>
				Promise.all([
					redeem(live.code, first.email),
					redeem(live.code.toUpperCase(), second.email),
				]),
		)
		const winners = results.filter((result) => result.purchase)
		expect(winners).toHaveLength(1)
		expect(await redeem(live.code, second.email)).toMatchObject({
			purchase: null,
			error: { message: 'coupon-is-invalid' },
		})
		const purchases = await db
			.select()
			.from(schema.purchases)
			.where(inArray(schema.purchases.userId, [first.id, second.id]))
		expect(purchases).toHaveLength(1)
		const purchase = purchases[0]!
		expect(purchase).toMatchObject({
			id: winners[0].purchase.id,
			productId: c5,
			couponId: live.couponRef,
			status: 'Valid',
			merchantChargeId: null,
		})
		expect(Number(purchase.totalAmount)).toBe(0)
		for (const claimant of [first, second]) {
			const access = await accessCache.read(
				`session-${claimant.id}`,
				claimant.id,
			)
			expect(access.status).toBe(
				claimant.id === purchase.userId ? 'miss' : 'hit',
			)
		}
		expect(bustUser.mock.calls).toEqual([[purchase.userId]])
		expect(committedAtBust.has(purchase.userId!)).toBe(true)
		// Internal receipt and bulk-purchase reads use the stored reference,
		// while code resolution and free redemption must not accept it.
		expect(await adapter.getCoupon(purchase.couponId!)).toMatchObject({
			id: live.couponRef,
			code: null,
		})
		expect(
			await adapter.getCouponWithBulkPurchases(purchase.couponId!),
		).toMatchObject({
			id: live.couponRef,
			code: null,
		})
		expect(
			await adapter.couponForIdOrCode({ couponId: purchase.couponId! }),
		).toBeNull()
		// The redeem thanks page uses this adapter port. Invoices read the coupon
		// by purchase.couponId directly, but a $0 comp has no invoice charge.
		expect(await adapter.getPurchaseWithUser(purchase.id)).toMatchObject({
			id: purchase.id,
			couponId: live.couponRef,
		})
		expect(
			await db.query.coupon.findFirst({
				where: eq(schema.coupon.id, purchase.couponId!),
			}),
		).toMatchObject({ id: live.couponRef })
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			name: 'commerce/full-price-coupon-redeemed',
			data: { purchaseId: purchase.id, productType: 'cohort' },
		})
		const used = await db.query.coupon.findFirst({
			where: eq(schema.coupon.id, live.couponRef),
		})
		expect(used?.usedCount).toBe(1)
		const { postPurchaseWorkflow } =
			await import('@/inngest/functions/post-purchase-workflow')
		const handler = (
			postPurchaseWorkflow as unknown as {
				handler: (args: Record<string, unknown>) => Promise<unknown>
			}
		).handler
		await handler({
			event: events[0],
			db: adapter,
			paymentProvider: {
				options: { paymentsAdapter: { getCheckoutSession: stripe } },
			},
			runId: 'coupon-test',
			step: {
				run: async (_id: string, work: () => Promise<unknown>) => work(),
				sendEvent: vi.fn(),
			},
		})
		const entitlements = await db
			.select()
			.from(schema.entitlements)
			.where(eq(schema.entitlements.sourceId, purchase.id))
		expect(entitlements.map((row) => row.entitlementType).sort()).toEqual([
			'coupon-test-cohort-access',
			'coupon-test-workshop-access',
		])
		expect(
			entitlements.every(
				(row) => row.userId === purchase.userId && row.deletedAt === null,
			),
		).toBe(true)
		const { hasEntitlementForResource } = await import('./entitlements-query')
		expect(
			await hasEntitlementForResource(purchase.userId!, 'cohort-xdy1m'),
		).toBe(true)
		expect(
			await hasEntitlementForResource(purchase.userId!, 'workshop-2ozd9'),
		).toBe(true)
		expect(
			await hasEntitlementForResource(
				purchase.userId === first.id ? second.id : first.id,
				'cohort-xdy1m',
			),
		).toBe(false)
		const legacyClaim = await redeem(
			rawLegacy.coupons[0]!.id,
			second.email,
			product,
		)
		expect(legacyClaim.purchase).toMatchObject({
			productId: product,
			status: 'Valid',
		})
		expect(stripe).not.toHaveBeenCalled()
		const wire = JSON.stringify({
			results,
			events,
			traces: Object.values(state.logger).map((fn) => fn.mock.calls),
		})
		for (const coupon of [live, expired])
			expect(wire.toLowerCase().includes(coupon.code)).toBe(false)
	})
})
