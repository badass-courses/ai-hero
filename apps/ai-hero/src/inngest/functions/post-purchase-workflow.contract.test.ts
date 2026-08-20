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
	createResourceEntitlements: vi.fn(),
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
	ENTITLEMENT_CONFIG: { 'self-paced': { resourceType: 'workshop' } },
	gatherResourceContexts: vi.fn(),
	getDiscordRoleId: vi.fn(),
	getResourceData: vi.fn(),
	PRODUCT_TYPE_CONFIG: {},
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

import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

import { postPurchaseWorkflow } from './post-purchase-workflow'

type Handler = (args: {
	event: {
		name: typeof NEW_PURCHASE_CREATED_EVENT
		data: {
			purchaseId: string
			checkoutSessionId: string | null
			invoiceId?: string
			productType: 'self-paced'
			quantity?: number
		}
	}
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
		sendEvent: (id: string, event: unknown) => Promise<unknown>
	}
	db: {
		getPurchase: (id: string) => Promise<unknown>
		getProduct: (id: string) => Promise<unknown>
		getUserById: (id: string) => Promise<unknown>
	}
	paymentProvider: {
		options: {
			paymentsAdapter: {
				getCheckoutSession: (id: string) => Promise<unknown>
			}
		}
	}
	runId: string
}) => Promise<unknown>

const handler = (postPurchaseWorkflow as unknown as { handler: Handler }).handler
const stopAfterConsumption = new Error('stop after entitlement consumption')

function createRun(results: unknown[]) {
	const adapter = {
		getPurchase: vi.fn(async (): Promise<unknown> => ({
			id: 'purchase_contract',
			userId: 'user_contract',
			productId: 'product_ai_coding_crash_course',
			status: 'Valid',
			totalAmount: 99,
			bulkCouponId: null,
			redeemedBulkCouponId: null,
			organizationId: null,
			createdAt: new Date('2026-08-17T00:00:00.000Z'),
		})),
		getProduct: vi.fn(async () => ({
			id: 'product_ai_coding_crash_course',
			name: 'AI Coding Crash Course',
			type: 'self-paced',
			resources: [],
		})),
		getUserById: vi.fn(async () => ({
			id: 'user_contract',
			email: 'learner@example.test',
		})),
	}
	const paymentProvider = {
		options: {
			paymentsAdapter: {
				getCheckoutSession: vi.fn(async () => ({
					id: 'cs_contract',
					metadata: {
						usedEntitlementCouponIds: 'coupon_alumni_credit_200',
					},
				})),
			},
		},
	}
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			if (id === 'get bulk coupon data') throw stopAfterConsumption
			const result = await callback()
			if (id === 'mark entitlement coupons as used') results.push(result)
			return result
		}),
		sendEvent: vi.fn(async () => undefined),
	}

	return { adapter, paymentProvider, step }
}

const event = {
	name: NEW_PURCHASE_CREATED_EVENT,
	data: {
		purchaseId: 'purchase_contract',
		checkoutSessionId: 'cs_contract',
		productType: 'self-paced' as const,
	},
} as const

describe('post-purchase exclusive-credit consumption contract', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state.consumed = false
		mocks.findEntitlementType.mockResolvedValue({
			id: 'entitlement_type_credit',
			name: 'apply_special_credit',
		})
	})

	it('consumes metadata.usedEntitlementCouponIds exactly once across a retry', async () => {
		const results: unknown[] = []

		for (const runId of ['run_first', 'run_retry']) {
			const { adapter, paymentProvider, step } = createRun(results)
			await expect(
				handler({ event, step, db: adapter, paymentProvider, runId }),
			).rejects.toBe(stopAfterConsumption)
		}

		expect(results).toEqual([
			{ marked: 1, couponIds: ['coupon_alumni_credit_200'] },
			{ marked: 0, couponIds: ['coupon_alumni_credit_200'] },
		])
		expect(mocks.findEntitlementType).toHaveBeenCalledTimes(2)
		expect(mocks.update).toHaveBeenCalledTimes(2)
		expect(mocks.updateSet).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ deletedAt: expect.any(Date) }),
		)
	})

})
