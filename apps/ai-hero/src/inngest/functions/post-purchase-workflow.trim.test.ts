import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const state = { consumed: false }
	const updateWhere = vi.fn(async () => {
		if (state.consumed) return { rowsAffected: 0 }
		state.consumed = true
		return { rowsAffected: 1 }
	})
	const updateSet = vi.fn(() => ({ where: updateWhere }))
	const update = vi.fn(() => ({ set: updateSet }))

	return {
		state,
		update,
		updateSet,
		updateWhere,
		findEntitlementType: vi.fn(),
		verify: vi.fn(async (..._args: unknown[]) => ({ failures: [] })),
		countCohorts: vi.fn(async (_userId: string): Promise<number> => 0),
		grantIncluded: vi.fn(async () => []),
		grantCore: vi.fn(async () => []),
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			flush: vi.fn(),
		},
	}
})

vi.mock('@/config', () => ({ default: {} }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: {
		query: {
			entitlementTypes: {
				findFirst: mocks.findEntitlementType,
			},
		},
		update: mocks.update,
	},
}))
vi.mock('@/lib/buy-path/verify-purchase', () => ({
	verifyPurchase: mocks.verify,
}))
vi.mock('@/lib/legend-cohort-count', () => ({
	countActiveDistinctCohortPurchasesForUser: mocks.countCohorts,
	shouldSendLegendEvent: (count: number | undefined) =>
		count === undefined || count >= 3,
}))
vi.mock('@/emails/live-office-hours-invitation', () => ({
	default: vi.fn(),
	generateICSAttachments: vi.fn(),
}))
vi.mock('@/emails/welcome-archive-email', () => ({ default: vi.fn() }))
vi.mock('@/emails/welcome-cohort-email-team', () => ({ default: vi.fn() }))
vi.mock('@/emails/welcome-workshop-email-team', () => ({ default: vi.fn() }))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://www.aihero.dev' },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: vi.fn(
			(_config: unknown, _trigger: unknown, handler: unknown) => ({ handler }),
		),
	},
}))
vi.mock('@/lib/archive-products', () => ({
	ARCHIVE_PRODUCT_TYPE: 'cohort-archive',
	ensureArchiveEntitlementContext: vi.fn(),
	getArchiveProductPolicy: vi.fn(),
	persistArchivePolicySnapshot: vi.fn(),
	reconcileArchivePurchaseEntitlements: vi.fn(),
}))
vi.mock('@/lib/entitlements', () => ({
	EntitlementSourceType: { COUPON: 'COUPON' },
}))
vi.mock('@/lib/entitlements-query', () => ({
	createResourceEntitlements: mocks.grantCore,
}))
vi.mock('@/lib/included-product-entitlements', () => ({
	grantIncludedProductEntitlements: mocks.grantIncluded,
	hasIncludedProductEntitlements: (productId: string) =>
		productId === 'product-s00zs',
}))
vi.mock('@/lib/personal-organization-service', () => ({
	ensurePersonalOrganizationWithLearnerRole: vi.fn(),
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@coursebuilder/utils/resource-paths', () => ({
	getResourcePath: vi.fn(() => '/workshops/contract'),
}))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: vi.fn(),
}))
vi.mock('../config/product-types', () => ({
	ENTITLEMENT_CONFIG: {
		'self-paced': { resourceType: 'workshop' },
		cohort: { resourceType: 'cohort' },
	},
	gatherResourceContexts: vi.fn(async () => [
		{
			resourceId: 'cohort-test',
			resourceType: 'cohort',
			productType: 'cohort',
		},
	]),
	getDiscordRoleId: vi.fn(),
	getResourceData: vi.fn(async () => ({
		id: 'cohort-test',
		type: 'cohort',
		fields: { title: 'Test' },
		resources: [],
	})),
	PRODUCT_TYPE_CONFIG: {
		cohort: {
			logPrefix: 'cohort',
			contentAccess: 'cohort_content_access',
			discordRole: 'cohort_discord_role',
		},
	},
	ProductType: {},
}))
vi.mock('../events/grant-coupon-entitlements-for-purchase', () => ({
	GRANT_COUPON_ENTITLEMENTS_FOR_PURCHASE_EVENT:
		'commerce/grant-coupon-entitlements-for-purchase',
}))
vi.mock('../events/grant-legend-discord-role', () => ({
	GRANT_LEGEND_DISCORD_ROLE_EVENT: 'discord/grant-legend-role',
}))
vi.mock('../events/post-purchase-async', () => ({
	POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT:
		'post-purchase/discord-role-requested',
	POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT:
		'post-purchase/welcome-email-requested',
}))

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/events/commerce'

import { postPurchaseWorkflow } from './post-purchase-workflow'

type Step = {
	run: ReturnType<typeof vi.fn<any[], any>>
	sendEvent: ReturnType<typeof vi.fn<any[], any>>
	sleep: ReturnType<typeof vi.fn<any[], any>>
}
type Handler = (args: Record<string, unknown>) => Promise<unknown>

const handler = (postPurchaseWorkflow as unknown as { handler: Handler })
	.handler

async function run(opts: {
	productType: 'cohort' | 'self-paced'
	checkoutSessionId: string | null
	cohortCount?: number
	countFails?: boolean
	verifyFails?: boolean
	status?: string
}) {
	const adapter = {
		getPurchase: vi.fn(async () => ({
			id: 'purchase_trim',
			userId: 'user_trim',
			productId: 'product_trim',
			status: opts.status ?? 'Valid',
			totalAmount: 99,
			bulkCouponId: null,
			redeemedBulkCouponId: null,
			organizationId: 'org_trim',
			createdAt: new Date('2026-08-17T00:00:00.000Z'),
		})),
		getProduct: vi.fn(async () => ({
			id: 'product_trim',
			name: 'Trim',
			type: opts.productType,
			resources: [],
		})),
		getUserById: vi.fn(async () => ({ id: 'user_trim', email: 'a@b.test' })),
		addMemberToOrganization: vi.fn(async () => ({ id: 'member_trim' })),
		addRoleForMember: vi.fn(async () => undefined),
	}
	if (opts.countFails) mocks.countCohorts.mockRejectedValue(new Error('db'))
	else mocks.countCohorts.mockResolvedValue(opts.cohortCount ?? 0)
	if (opts.verifyFails) mocks.verify.mockRejectedValue(new Error('read'))
	const executed: string[] = []
	const step: Step = {
		run: vi.fn(async (id: string, cb: () => Promise<unknown>) => {
			executed.push(id)
			if (id === 'get bulk coupon data') return null
			if (id === 'mark entitlement coupons as used') return null
			return cb()
		}),
		sendEvent: vi.fn(async () => undefined),
		sleep: vi.fn(async () => undefined),
	}
	await handler({
		event: {
			name: NEW_PURCHASE_CREATED_EVENT,
			data: {
				purchaseId: 'purchase_trim',
				checkoutSessionId: opts.checkoutSessionId,
				productType: opts.productType,
			},
		},
		step,
		db: adapter,
		paymentProvider: {
			options: {
				paymentsAdapter: { getCheckoutSession: vi.fn(async () => ({})) },
			},
		},
		runId: 'run_trim',
	})
	const legendSent = step.sendEvent.mock.calls.some(
		([id]) => id === 'grant legend discord role',
	)
	return { step, executed, legendSent }
}

describe('post-purchase verify readback', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findEntitlementType.mockResolvedValue({ id: 't', name: 'n' })
	})

	it('verifies without a sleep or verify step, with the same arguments', async () => {
		const { step, executed } = await run({
			productType: 'self-paced',
			checkoutSessionId: 'cs_test_a1b2c3',
		})
		expect(step.sleep).not.toHaveBeenCalled()
		expect(executed).not.toContain('verify buy path persisted invariants')
		expect(mocks.verify).toHaveBeenCalledTimes(1)
		expect(mocks.verify).toHaveBeenCalledWith(
			{
				buyPathId: 'cs_test_a1b2c3',
				purchaseId: 'purchase_trim',
				productId: 'product_trim',
				userId: 'user_trim',
			},
			1,
		)
	})

	it('does not verify for non-checkout purchases', async () => {
		await run({ productType: 'self-paced', checkoutSessionId: null })
		expect(mocks.verify).not.toHaveBeenCalled()
	})

	it('swallows a failing readback instead of failing the workflow', async () => {
		await expect(
			run({
				productType: 'self-paced',
				checkoutSessionId: 'cs_test_a1b2c3',
				verifyFails: true,
			}),
		).resolves.toBeDefined()
		expect(mocks.verify).toHaveBeenCalledTimes(1)
	})
})

describe('post-purchase legend event', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findEntitlementType.mockResolvedValue({ id: 't', name: 'n' })
	})

	it.each([
		{ cohortCount: 0, sent: false },
		{ cohortCount: 2, sent: false },
		{ cohortCount: 3, sent: true },
		{ cohortCount: 5, sent: true },
	])('cohort with $cohortCount active cohorts sends: $sent', async (c) => {
		const { legendSent } = await run({
			productType: 'cohort',
			checkoutSessionId: null,
			cohortCount: c.cohortCount,
		})
		expect(legendSent).toBe(c.sent)
		expect(mocks.countCohorts).toHaveBeenCalledWith('user_trim')
	})

	it('keeps sending when the count is unavailable', async () => {
		const { legendSent } = await run({
			productType: 'cohort',
			checkoutSessionId: null,
			countFails: true,
		})
		expect(legendSent).toBe(true)
	})

	it('never counts or sends for non-cohort purchases', async () => {
		const { legendSent } = await run({
			productType: 'self-paced',
			checkoutSessionId: null,
			cohortCount: 9,
		})
		expect(legendSent).toBe(false)
		expect(mocks.countCohorts).not.toHaveBeenCalled()
	})
})
