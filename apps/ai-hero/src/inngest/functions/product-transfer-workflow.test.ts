/**
 * Checkpoint, duplicate-event, and completion-gate tests for the product
 * transfer workflow (AIH-223 / AIH-209).
 *
 * The harness simulates Inngest step memoization: a step that committed
 * before a worker crash is not re-executed on retry. The fake database is
 * an in-memory entitlements table that genuinely evaluates the drizzle
 * `eq`/`and`/`isNull` predicates the workflow builds, so entitlement
 * identity and counts are asserted against real rows, not counters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type EntitlementRow = {
	id: string
	userId: string
	entitlementType: string
	sourceType: string
	sourceId: string
	metadata: Record<string, unknown> | null
	deletedAt: Date | null
	organizationId?: string
	organizationMembershipId?: string
	expiresAt?: Date | null
}

type World = {
	purchase: {
		id: string
		userId: string
		organizationId: string
		status: string
		bulkCouponId: string | null
		productId: string
	}
	productType: string
	transferState: string
	completedWrites: number
	entitlements: EntitlementRow[]
	learnerRoleAdded: boolean
	discordRoleRemovals: number
	guidCounter: number
	/** Simulates a product whose Discord role entitlement type is not seeded. */
	discordTypeMissing: boolean
}

type Predicate =
	| { op: 'eq'; col: string; val: unknown }
	| { op: 'isNull'; col: string }
	| { op: 'and'; parts: Predicate[] }

const mocks = vi.hoisted(() => {
	const state: { world: World } = { world: null as unknown as World }

	const column = (col: string) => col.split('.')[1] as keyof EntitlementRow

	function matches(
		row: Record<string, unknown>,
		where: Predicate | undefined,
	): boolean {
		if (!where) return true
		switch (where.op) {
			case 'eq':
				return row[column(where.col)] === where.val
			case 'isNull':
				return row[column(where.col)] == null
			case 'and':
				return where.parts.every((part) => matches(row, part))
		}
	}

	function fakeExecutor() {
		return {
			update: (table: { tag: string }) => ({
				set: (values: Record<string, unknown>) => ({
					where: async (where: Predicate) => {
						const world = state.world
						if (table.tag === 'purchases') {
							if (typeof values.organizationId === 'string') {
								world.purchase.organizationId = values.organizationId
							}
							return [{ affectedRows: 1 }]
						}
						if (table.tag === 'entitlements') {
							let affectedRows = 0
							for (const row of world.entitlements) {
								if (!matches(row, where)) continue
								Object.assign(row, values)
								affectedRows += 1
							}
							return [{ affectedRows }]
						}
						if (table.tag === 'purchaseUserTransfer') {
							if (values.transferState === 'COMPLETED') {
								// Compare-and-swap: only VERIFIED rows complete.
								if (world.transferState !== 'VERIFIED') {
									return [{ affectedRows: 0 }]
								}
								world.transferState = 'COMPLETED'
								world.completedWrites += 1
								return [{ affectedRows: 1 }]
							}
							return [{ affectedRows: 1 }]
						}
						return [{ affectedRows: 1 }]
					},
				}),
			}),
			insert: (table: { tag: string }) => ({
				values: async (values: Record<string, unknown>) => {
					if (table.tag !== 'entitlements') return
					const row = values as Partial<EntitlementRow>
					state.world.entitlements.push({
						...(row as EntitlementRow),
						deletedAt: row.deletedAt ?? null,
						metadata: row.metadata ?? null,
					})
				},
			}),
		}
	}

	const columns = (tag: string, names: string[]) =>
		Object.fromEntries([
			['tag', tag],
			...names.map((name) => [name, `${tag}.${name}`]),
		])

	return {
		state,
		matches,
		fakeExecutor,
		columns,
		CONTENT_TYPE: 'cohort_content_access',
		DISCORD_TYPE: 'cohort_discord_role',
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		createResourceEntitlements: vi.fn(),
		createEntitlement: vi.fn(),
		removeDiscordRole: vi.fn(),
		getCreditEntitlementsForSourcePurchase: vi.fn(),
		ensurePersonalOrganization: vi.fn(),
	}
})

const PURCHASE_ID = 'purchase_1'
const PRODUCT_ID = 'product_1'
/** The single workshop attached to cohort_1; content access is keyed to it. */
const WORKSHOP_ID = 'workshop_1'
const { CONTENT_TYPE, DISCORD_TYPE } = mocks

const sourceContentRow = (n: number): EntitlementRow => ({
	id: `src_content_${n}`,
	userId: 'user_a',
	entitlementType: CONTENT_TYPE,
	sourceType: 'PURCHASE',
	sourceId: PURCHASE_ID,
	metadata: { contentIds: [WORKSHOP_ID] },
	deletedAt: null,
	organizationId: 'org_a',
	organizationMembershipId: 'member_a',
})

const sourceDiscordRow = (): EntitlementRow => ({
	id: 'src_discord',
	userId: 'user_a',
	entitlementType: DISCORD_TYPE,
	sourceType: 'PURCHASE',
	sourceId: PURCHASE_ID,
	metadata: { discordRoleId: 'discord_role_1' },
	deletedAt: null,
})

const sourceArchiveRow = (): EntitlementRow => ({
	id: 'src_archive',
	userId: 'user_a',
	entitlementType: CONTENT_TYPE,
	sourceType: 'PURCHASE',
	sourceId: PURCHASE_ID,
	metadata: { archiveProductId: PRODUCT_ID, archiveCohortId: 'cohort_old' },
	deletedAt: null,
	expiresAt: null,
})

function freshWorld(overrides: Partial<World> = {}): World {
	return {
		purchase: {
			id: PURCHASE_ID,
			// Ownership already moved by the accept action before the event fires.
			userId: 'user_b',
			organizationId: 'org_a',
			status: 'Valid',
			bulkCouponId: null,
			productId: PRODUCT_ID,
		},
		productType: 'cohort',
		transferState: 'VERIFIED',
		completedWrites: 0,
		entitlements: [
			sourceContentRow(0),
			sourceContentRow(1),
			sourceDiscordRow(),
		],
		learnerRoleAdded: false,
		discordRoleRemovals: 0,
		guidCounter: 0,
		discordTypeMissing: false,
		...overrides,
	}
}

function activeRowsFor(userId: string) {
	return mocks.state.world.entitlements.filter(
		(row) =>
			row.userId === userId &&
			row.sourceId === PURCHASE_ID &&
			row.deletedAt === null,
	)
}

const activeIds = (userId: string) =>
	activeRowsFor(userId)
		.map((row) => row.id)
		.sort()

vi.mock('drizzle-orm', () => ({
	eq: (col: string, val: unknown) => ({ op: 'eq', col, val }),
	isNull: (col: string) => ({ op: 'isNull', col }),
	and: (...parts: Predicate[]) => ({ op: 'and', parts }),
}))

vi.mock('@coursebuilder/adapter-drizzle/mysql', () => ({
	guid: () => `g${mocks.state.world.guidCounter++}`,
}))

vi.mock('@/db', () => ({
	db: {
		...mocks.fakeExecutor(),
		transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn(mocks.fakeExecutor()),
		query: {
			entitlementTypes: {
				// Type ids equal their names so archive detection (which compares
				// the stored entitlementType against 'cohort_content_access') is
				// exercised for real.
				findFirst: vi.fn(async ({ where }: { where: Predicate }) => {
					if (where.op !== 'eq') return null
					if (
						where.val === mocks.DISCORD_TYPE &&
						mocks.state.world.discordTypeMissing
					) {
						return null
					}
					return { id: where.val, name: where.val }
				}),
			},
			purchases: {
				findFirst: vi.fn(async () => ({ ...mocks.state.world.purchase })),
			},
			organizationMemberships: {
				findMany: vi.fn(async () => [
					{
						id: 'member_b',
						organizationId: 'org_b',
						organizationMembershipRoles: mocks.state.world.learnerRoleAdded
							? [{ active: true, deletedAt: null, role: { name: 'learner' } }]
							: [],
					},
				]),
			},
			entitlements: {
				findMany: vi.fn(async ({ where }: { where?: Predicate }) =>
					mocks.state.world.entitlements
						.filter((row) => mocks.matches(row, where))
						.map((row) => ({ ...row })),
				),
				findFirst: vi.fn(async ({ where }: { where?: Predicate }) => {
					const row = mocks.state.world.entitlements.find((candidate) =>
						mocks.matches(candidate, where),
					)
					return row ? { ...row } : undefined
				}),
			},
			purchaseUserTransfer: {
				findFirst: vi.fn(async () => ({
					id: 'put_1',
					transferState: mocks.state.world.transferState,
				})),
			},
		},
	},
}))

vi.mock('@/db/schema', () => ({
	entitlements: mocks.columns('entitlements', [
		'id',
		'userId',
		'entitlementType',
		'sourceType',
		'sourceId',
		'deletedAt',
		'organizationId',
		'organizationMembershipId',
	]),
	entitlementTypes: mocks.columns('entitlementTypes', ['id', 'name']),
	organizationMemberships: mocks.columns('organizationMemberships', [
		'id',
		'userId',
		'organizationId',
	]),
	purchases: mocks.columns('purchases', ['id', 'userId', 'organizationId']),
	purchaseUserTransfer: mocks.columns('purchaseUserTransfer', [
		'id',
		'transferState',
	]),
}))

vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: vi.fn(() => ({})) },
}))
vi.mock('@/lib/cohorts-query', () => ({ getCohort: vi.fn() }))
vi.mock('@/lib/workshops-query', () => ({ getWorkshop: vi.fn() }))
vi.mock('@/lib/discord-utils', () => ({
	removeDiscordRole: mocks.removeDiscordRole,
}))
vi.mock('@/lib/entitlements', () => ({
	createCohortEntitlement: vi.fn(),
	createWorkshopEntitlement: vi.fn(),
	EntitlementSourceType: { PURCHASE: 'PURCHASE', COUPON: 'COUPON' },
	getCreditEntitlementsForSourcePurchase:
		mocks.getCreditEntitlementsForSourcePurchase,
}))
vi.mock('@/lib/entitlements-query', () => ({
	createResourceEntitlements: mocks.createResourceEntitlements,
}))
vi.mock('@/lib/personal-organization-service', () => ({
	ensurePersonalOrganization: mocks.ensurePersonalOrganization,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/inngest/config/product-types', () => ({
	gatherResourceContexts: vi.fn(async () => [
		{ resourceId: 'cohort_1', resourceType: 'cohort', productType: 'cohort' },
	]),
	getResourceData: vi.fn(async () => ({
		id: 'cohort_1',
		type: 'cohort',
		resources: [
			{ resource: { id: 'workshop_1', type: 'workshop' } },
			// Cohorts also attach reminder emails; those never become access.
			{ resource: { id: 'email_1', type: 'email' } },
		],
	})),
	PRODUCT_TYPE_CONFIG: {
		cohort: {
			logPrefix: 'cohort',
			resourceType: 'cohort',
			contentAccess: mocks.CONTENT_TYPE,
			discordRole: mocks.DISCORD_TYPE,
			discordEvent: 'cohort/discord-role-requested',
			getDiscordRoleId: () => 'discord_role_1',
			createEntitlement: mocks.createEntitlement,
		},
	},
}))

import { handleProductTransfer } from './product-transfer-workflow'

class WorkerCrash extends Error {
	constructor(afterStep: string) {
		super(`worker crashed after checkpoint: ${afterStep}`)
	}
}

/**
 * Simulates Inngest step memoization: completed checkpoints persist and
 * are not re-executed on retry. `crashAfter` kills the worker right after
 * the named checkpoint commits.
 */
function createStepHarness(memo = new Map<string, unknown>()) {
	const executed: string[] = []
	const control = { crashAfter: null as string | null }
	const step = {
		run: async (name: string, fn: () => Promise<unknown>) => {
			if (memo.has(name)) return memo.get(name)
			const result = await fn()
			memo.set(name, result === undefined ? null : result)
			executed.push(name)
			if (control.crashAfter === name) throw new WorkerCrash(name)
			return result
		},
		sendEvent: async (name: string, _event: unknown) => {
			const key = `sendEvent:${name}`
			if (memo.has(key)) return
			memo.set(key, true)
			executed.push(key)
			if (control.crashAfter === key) throw new WorkerCrash(key)
		},
	}
	return { step, memo, executed, control }
}

function createAdapter() {
	return {
		getPurchase: vi.fn(async () => ({ ...mocks.state.world.purchase })),
		getProduct: vi.fn(async () => ({
			id: PRODUCT_ID,
			type: mocks.state.world.productType,
			resources: [{ resource: { id: 'cohort_1', type: 'cohort' } }],
		})),
		getUserById: vi.fn(async (id: string) => ({
			id,
			email: `${id}@example.com`,
		})),
		getMembershipsForUser: vi.fn(async () => [
			{ id: 'member_b', organizationId: 'org_b' },
		]),
		addRoleForMember: vi.fn(async () => {
			mocks.state.world.learnerRoleAdded = true
		}),
	}
}

const event = {
	data: {
		purchaseId: PURCHASE_ID,
		sourceUserId: 'user_a',
		targetUserId: 'user_b',
		purchaseUserTransferId: 'put_1',
	},
}

async function runWorkflow(memo?: Map<string, unknown>) {
	const harness = createStepHarness(memo)
	const result = await handleProductTransfer({
		event,
		step: harness.step,
		db: createAdapter(),
		transferSource: 'ui',
	})
	return { harness, result }
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.state.world = freshWorld()
	mocks.getCreditEntitlementsForSourcePurchase.mockResolvedValue([])
	mocks.ensurePersonalOrganization.mockResolvedValue({
		organization: { id: 'org_b' },
	})
	mocks.removeDiscordRole.mockImplementation(async () => {
		mocks.state.world.discordRoleRemovals += 1
		return { removed: true }
	})
	// Mirrors the real createResourceEntitlements: one content row per
	// workshop child of the cohort, skipped when the user already holds ANY
	// active row of that type listing the workshop — regardless of which
	// purchase, coupon, or subscription sourced it (hasExistingEntitlement
	// has no source filter). Rows land in the org/membership passed in.
	mocks.createResourceEntitlements.mockImplementation(
		async (
			_productType: string,
			resource: {
				id: string
				resources?: Array<{ resource?: { id: string; type?: string } }>
			},
			context: {
				user: { id: string }
				purchase: { id: string }
				organizationId: string
				orgMembership: { id: string }
				contentAccessEntitlementType: { id: string }
			},
		) => {
			const world = mocks.state.world
			const created: EntitlementRow[] = []
			const children = (resource.resources ?? [])
				.map((item) => item.resource)
				.filter((child) => child?.type === 'workshop')
			for (const child of children) {
				if (!child) continue
				const existing = world.entitlements.find(
					(row) =>
						row.userId === context.user.id &&
						row.entitlementType === context.contentAccessEntitlementType.id &&
						row.deletedAt === null &&
						(row.metadata?.contentIds as string[] | undefined)?.includes(
							child.id,
						),
				)
				if (existing) continue
				const row: EntitlementRow = {
					id: `tgt_content_${world.guidCounter++}`,
					userId: context.user.id,
					entitlementType: context.contentAccessEntitlementType.id,
					sourceType: 'PURCHASE',
					sourceId: context.purchase.id,
					metadata: { contentIds: [child.id] },
					deletedAt: null,
					organizationId: context.organizationId,
					organizationMembershipId: context.orgMembership.id,
				}
				world.entitlements.push(row)
				created.push(row)
			}
			return created
		},
	)
	mocks.createEntitlement.mockImplementation(
		async (values: Omit<EntitlementRow, 'deletedAt'>) => {
			mocks.state.world.entitlements.push({ ...values, deletedAt: null })
		},
	)
})

describe('happy path', () => {
	it('completes exactly once with the expected entitlement identities on both sides', async () => {
		await runWorkflow()
		const world = mocks.state.world
		expect(world.transferState).toBe('COMPLETED')
		expect(world.completedWrites).toBe(1)
		expect(world.purchase.organizationId).toBe('org_b')
		expect(world.learnerRoleAdded).toBe(true)
		expect(activeIds('user_a')).toEqual([])
		const target = activeRowsFor('user_b')
		expect(target).toHaveLength(2)
		expect(target.map((row) => row.entitlementType).sort()).toEqual([
			CONTENT_TYPE,
			DISCORD_TYPE,
		])
		expect(world.discordRoleRemovals).toBe(1)
	})
})

describe('duplicate events', () => {
	it('after COMPLETED: short-circuits, runs no entitlement code, and leaves identities untouched', async () => {
		await runWorkflow()
		const before = activeIds('user_b')
		const rowCount = mocks.state.world.entitlements.length
		mocks.createResourceEntitlements.mockClear()
		mocks.createEntitlement.mockClear()

		const { harness, result } = await runWorkflow()

		expect(result).toMatchObject({
			replayed: true,
			transferState: 'COMPLETED',
		})
		expect(harness.executed).toEqual([
			'log transfer initiated',
			'check transfer replay state',
			'log duplicate transfer event skipped',
		])
		expect(mocks.createResourceEntitlements).not.toHaveBeenCalled()
		expect(mocks.createEntitlement).not.toHaveBeenCalled()
		expect(activeIds('user_b')).toEqual(before)
		expect(mocks.state.world.entitlements).toHaveLength(rowCount)
		expect(mocks.state.world.completedWrites).toBe(1)
		expect(mocks.state.world.discordRoleRemovals).toBe(1)
	})

	it('while still VERIFIED (entitlements written, completion not yet reached): re-running mints nothing new', async () => {
		const first = createStepHarness()
		first.control.crashAfter = 'add entitlements to target user'
		await expect(
			handleProductTransfer({
				event,
				step: first.step,
				db: createAdapter(),
				transferSource: 'ui',
			}),
		).rejects.toThrow('worker crashed')
		expect(mocks.state.world.transferState).toBe('VERIFIED')
		const afterFirstAttempt = activeIds('user_b')
		expect(afterFirstAttempt).toHaveLength(2)
		const rowCount = mocks.state.world.entitlements.length

		// A second delivery of the same event with fresh memoization runs the
		// whole machinery again against the half-done world.
		await runWorkflow()

		expect(mocks.state.world.transferState).toBe('COMPLETED')
		expect(mocks.state.world.completedWrites).toBe(1)
		expect(activeIds('user_b')).toEqual(afterFirstAttempt)
		expect(mocks.state.world.entitlements).toHaveLength(rowCount)
		expect(activeIds('user_a')).toEqual([])

		// The original run resumes from its memo and finds the row terminal.
		first.control.crashAfter = null
		await handleProductTransfer({
			event,
			step: first.step,
			db: createAdapter(),
			transferSource: 'ui',
		})
		expect(mocks.state.world.completedWrites).toBe(1)
		expect(activeIds('user_b')).toEqual(afterFirstAttempt)
	})
})

describe('worker crash checkpoints', () => {
	it('crashing after any checkpoint and resuming converges to one completion with identical entitlement identities', async () => {
		// Baseline run to learn the checkpoint order and expected effects.
		const baselineRun = await runWorkflow()
		const checkpoints = [...baselineRun.harness.executed]
		const baselineTargetIds = activeIds('user_b')
		expect(checkpoints.length).toBeGreaterThan(5)
		expect(checkpoints).toContain('verify transfer completion invariants')
		expect(checkpoints).toContain('mark transfer completed')

		for (const checkpoint of checkpoints) {
			mocks.state.world = freshWorld()
			const crashing = createStepHarness()
			crashing.control.crashAfter = checkpoint
			await expect(
				handleProductTransfer({
					event,
					step: crashing.step,
					db: createAdapter(),
					transferSource: 'ui',
				}),
			).rejects.toThrow('worker crashed after checkpoint')

			// Retry on the same durable step memoization.
			crashing.control.crashAfter = null
			await handleProductTransfer({
				event,
				step: crashing.step,
				db: createAdapter(),
				transferSource: 'ui',
			})

			const world = mocks.state.world
			expect(world.transferState, `after crash at ${checkpoint}`).toBe(
				'COMPLETED',
			)
			expect(world.completedWrites, `after crash at ${checkpoint}`).toBe(1)
			expect(activeIds('user_b'), `after crash at ${checkpoint}`).toEqual(
				baselineTargetIds,
			)
			expect(activeIds('user_a'), `after crash at ${checkpoint}`).toEqual([])
			expect(
				world.discordRoleRemovals,
				`after crash at ${checkpoint}`,
			).toBeLessThanOrEqual(1)
		}
	})
})

describe('archive products', () => {
	it('moves archive-derived entitlements and completes when something was transferred', async () => {
		mocks.state.world = freshWorld({
			productType: 'cohort-archive',
			// The source also holds a non-archive row for the same purchase; the
			// archive path does not own it and must not be blocked by it.
			entitlements: [sourceArchiveRow(), sourceDiscordRow()],
		})

		await runWorkflow()

		const world = mocks.state.world
		expect(world.transferState).toBe('COMPLETED')
		expect(world.completedWrites).toBe(1)
		expect(world.purchase.organizationId).toBe('org_b')
		const target = activeRowsFor('user_b')
		expect(target).toHaveLength(1)
		expect(target[0]?.metadata).toEqual(sourceArchiveRow().metadata)
		expect(activeIds('user_a')).toEqual(['src_discord'])
		expect(mocks.createResourceEntitlements).not.toHaveBeenCalled()
	})

	it('completes with zero moves when the source holds no archive-derived entitlements', async () => {
		mocks.state.world = freshWorld({
			productType: 'cohort-archive',
			entitlements: [],
		})

		await runWorkflow()

		expect(mocks.state.world.transferState).toBe('COMPLETED')
		expect(mocks.state.world.completedWrites).toBe(1)
		expect(mocks.state.world.entitlements).toHaveLength(0)
	})

	it('a duplicate archive event after completion does not mint a second archive row', async () => {
		mocks.state.world = freshWorld({
			productType: 'cohort-archive',
			entitlements: [sourceArchiveRow()],
		})
		await runWorkflow()
		const before = activeIds('user_b')
		await runWorkflow()
		expect(activeIds('user_b')).toEqual(before)
		expect(mocks.state.world.entitlements).toHaveLength(2)
		expect(mocks.state.world.completedWrites).toBe(1)
	})
})

describe('non-transferable product types', () => {
	it('reaches COMPLETED through the ownership-only invariant without moving any entitlements', async () => {
		mocks.state.world = freshWorld({ productType: 'live' })
		const before = mocks.state.world.entitlements.map((row) => ({ ...row }))

		const { harness } = await runWorkflow()

		const world = mocks.state.world
		expect(world.transferState).toBe('COMPLETED')
		expect(world.completedWrites).toBe(1)
		expect(world.entitlements).toEqual(before)
		expect(world.purchase.organizationId).toBe('org_a')
		expect(world.learnerRoleAdded).toBe(false)
		expect(mocks.ensurePersonalOrganization).not.toHaveBeenCalled()
		expect(harness.executed).not.toContain('add entitlements to target user')
		expect(mocks.log.info).toHaveBeenCalledWith(
			'No entitlement work for product type',
			expect.objectContaining({ productType: 'live' }),
		)
	})

	it('is refused, and stays VERIFIED, when purchase ownership never moved', async () => {
		mocks.state.world = freshWorld({ productType: 'live' })
		mocks.state.world.purchase.userId = 'user_a'
		const before = mocks.state.world.entitlements.map((row) => ({ ...row }))

		await expect(runWorkflow()).rejects.toThrow(/purchase_owner_mismatch/)

		expect(mocks.state.world.transferState).toBe('VERIFIED')
		expect(mocks.state.world.completedWrites).toBe(0)
		expect(mocks.state.world.entitlements).toEqual(before)
	})
})

/** Active content rows for the target that list the transferred workshop. */
function targetContentRowsFor(resourceId: string) {
	return mocks.state.world.entitlements.filter(
		(row) =>
			row.userId === 'user_b' &&
			row.entitlementType === CONTENT_TYPE &&
			row.deletedAt === null &&
			(row.metadata?.contentIds as string[] | undefined)?.includes(resourceId),
	)
}

/** Access the target already holds to workshop_1 from an unrelated purchase. */
const preExistingTargetAccessRow = (): EntitlementRow => ({
	id: 'tgt_existing_other_purchase',
	userId: 'user_b',
	entitlementType: CONTENT_TYPE,
	sourceType: 'PURCHASE',
	sourceId: 'purchase_other',
	metadata: { contentIds: [WORKSHOP_ID] },
	deletedAt: null,
	organizationId: 'org_team',
	organizationMembershipId: 'member_team',
})

describe('pre-existing target access', () => {
	it('converges to COMPLETED on the existing access without minting a duplicate content entitlement', async () => {
		mocks.state.world = freshWorld({
			entitlements: [
				sourceContentRow(0),
				sourceDiscordRow(),
				preExistingTargetAccessRow(),
			],
		})

		await runWorkflow()

		const world = mocks.state.world
		expect(world.transferState).toBe('COMPLETED')
		expect(world.completedWrites).toBe(1)
		// createResourceEntitlements skipped the duplicate, so the only content
		// row for workshop_1 is the pre-existing one from the other purchase.
		expect(mocks.createResourceEntitlements).toHaveBeenCalledTimes(1)
		const contentRows = targetContentRowsFor(WORKSHOP_ID)
		expect(contentRows.map((row) => row.id)).toEqual([
			'tgt_existing_other_purchase',
		])
		// No content row sourced from the transferred purchase was minted.
		expect(
			activeRowsFor('user_b').filter(
				(row) => row.entitlementType === CONTENT_TYPE,
			),
		).toEqual([])
		// The Discord role entitlement is still granted from this purchase.
		expect(activeRowsFor('user_b').map((row) => row.entitlementType)).toEqual([
			DISCORD_TYPE,
		])
		expect(activeIds('user_a')).toEqual([])
	})

	it('converges even when existing access is the only row the target holds (no Discord type seeded)', async () => {
		// Nothing is minted from the current purchase at all, so a gate that
		// demands a row with sourceId = current purchase would strand the
		// transfer at VERIFIED forever.
		mocks.state.world = freshWorld({
			discordTypeMissing: true,
			entitlements: [sourceContentRow(0), preExistingTargetAccessRow()],
		})

		await runWorkflow()

		const world = mocks.state.world
		expect(world.transferState).toBe('COMPLETED')
		expect(world.completedWrites).toBe(1)
		expect(activeRowsFor('user_b')).toEqual([])
		expect(targetContentRowsFor(WORKSHOP_ID).map((row) => row.id)).toEqual([
			'tgt_existing_other_purchase',
		])
		expect(activeIds('user_a')).toEqual([])
	})

	it('a retry after a crash past the entitlement step still reaches COMPLETED with one content row', async () => {
		mocks.state.world = freshWorld({
			entitlements: [
				sourceContentRow(0),
				sourceDiscordRow(),
				preExistingTargetAccessRow(),
			],
		})
		const first = createStepHarness()
		first.control.crashAfter = 'add entitlements to target user'
		await expect(
			handleProductTransfer({
				event,
				step: first.step,
				db: createAdapter(),
				transferSource: 'ui',
			}),
		).rejects.toThrow('worker crashed')
		expect(mocks.state.world.transferState).toBe('VERIFIED')
		const rowCount = mocks.state.world.entitlements.length

		// Fresh delivery re-runs the whole machinery against the half-done world.
		await runWorkflow()
		expect(mocks.state.world.transferState).toBe('COMPLETED')
		expect(mocks.state.world.completedWrites).toBe(1)
		expect(targetContentRowsFor(WORKSHOP_ID).map((row) => row.id)).toEqual([
			'tgt_existing_other_purchase',
		])
		expect(mocks.state.world.entitlements).toHaveLength(rowCount)

		// The original run resumes from its memo and stays a no-op.
		first.control.crashAfter = null
		await handleProductTransfer({
			event,
			step: first.step,
			db: createAdapter(),
			transferSource: 'ui',
		})
		expect(mocks.state.world.completedWrites).toBe(1)
		expect(mocks.state.world.entitlements).toHaveLength(rowCount)
	})

	it('existing access covering a different workshop does not satisfy the transferred one', async () => {
		mocks.state.world = freshWorld({
			entitlements: [
				sourceContentRow(0),
				sourceDiscordRow(),
				{
					...preExistingTargetAccessRow(),
					metadata: { contentIds: ['workshop_other'] },
				},
			],
		})
		// Minting is lost, so nothing covers workshop_1.
		mocks.createResourceEntitlements.mockImplementation(async () => [])
		await expect(runWorkflow()).rejects.toThrow(/target_entitlements_missing/)
		expect(mocks.state.world.transferState).toBe('VERIFIED')
		expect(mocks.log.error).toHaveBeenCalledWith(
			'purchase_transfer.completion_invariants_failed',
			expect.objectContaining({
				missingAccess: [
					{ entitlementTypeId: CONTENT_TYPE, resourceId: WORKSHOP_ID },
				],
			}),
		)
	})
})

describe('completion gate', () => {
	it('refuses COMPLETED while the target has no active entitlements', async () => {
		// No target access seeded anywhere: freshWorld holds source rows only.
		expect(activeRowsFor('user_b')).toEqual([])
		mocks.createResourceEntitlements.mockImplementation(async () => [])
		mocks.createEntitlement.mockImplementation(async () => {})
		await expect(runWorkflow()).rejects.toThrow(
			/Transfer completion invariants failed.*target_entitlements_missing/,
		)
		expect(mocks.state.world.transferState).toBe('VERIFIED')
		expect(mocks.state.world.completedWrites).toBe(0)
	})

	it('refuses COMPLETED when the current-purchase entitlement landed in the wrong organization', async () => {
		const base = mocks.createResourceEntitlements.getMockImplementation()!
		mocks.createResourceEntitlements.mockImplementation(
			async (productType, resource, context) =>
				base(productType, resource, {
					...context,
					organizationId: 'org_stale',
				}),
		)
		await expect(runWorkflow()).rejects.toThrow(
			/target_entitlement_wrong_organization/,
		)
		expect(mocks.state.world.transferState).toBe('VERIFIED')
		expect(mocks.state.world.completedWrites).toBe(0)
		// The misplaced row also fails the access requirement: it never counts.
		expect(mocks.log.error).toHaveBeenCalledWith(
			'purchase_transfer.completion_invariants_failed',
			expect.objectContaining({
				failures: expect.arrayContaining([
					'target_entitlement_wrong_organization',
					'target_entitlements_missing',
				]),
			}),
		)
	})

	it('refuses COMPLETED when the current-purchase entitlement landed on the wrong membership', async () => {
		const base = mocks.createResourceEntitlements.getMockImplementation()!
		mocks.createResourceEntitlements.mockImplementation(
			async (productType, resource, context) =>
				base(productType, resource, {
					...context,
					orgMembership: { id: 'member_stale' },
				}),
		)
		await expect(runWorkflow()).rejects.toThrow(
			/target_entitlement_wrong_membership/,
		)
		expect(mocks.state.world.transferState).toBe('VERIFIED')
		expect(mocks.state.world.completedWrites).toBe(0)
	})

	it('refuses COMPLETED while the learner role is missing', async () => {
		const adapter = createAdapter()
		adapter.addRoleForMember.mockImplementation(async () => {
			// Role write silently lost.
		})
		const harness = createStepHarness()
		await expect(
			handleProductTransfer({
				event,
				step: harness.step,
				db: adapter,
				transferSource: 'ui',
			}),
		).rejects.toThrow(/target_learner_role_missing/)
		expect(mocks.state.world.transferState).toBe('VERIFIED')
	})

	it('refuses COMPLETED when the purchase never reached the target owner', async () => {
		mocks.state.world.purchase.userId = 'user_a'
		await expect(runWorkflow()).rejects.toThrow(/purchase_owner_mismatch/)
		expect(mocks.state.world.transferState).toBe('VERIFIED')
	})

	it('logs the exact failing invariants for observability', async () => {
		mocks.state.world.purchase.userId = 'user_a'
		await expect(runWorkflow()).rejects.toThrow()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'purchase_transfer.completion_invariants_failed',
			expect.objectContaining({
				failures: expect.arrayContaining(['purchase_owner_mismatch']),
			}),
		)
	})
})
