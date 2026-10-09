import { db, type DbExecutor } from '@/db'
import {
	entitlements,
	entitlementTypes,
	purchases,
	purchaseUserTransfer,
	users,
} from '@/db/schema'
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'

import type { DiscordRoleClient } from './discord-utils'
import { EntitlementSourceType } from './entitlements'
import {
	ACCESS_STATUSES,
	decideDisputeTransition,
	readDisputeRecord,
	type BuyerBlockOutcome,
	type DiscordRoleSyncResult,
	type DisputeEventType,
	type DisputeState,
	type PurchaseDisputeRecord,
	type PurchaseStatus,
} from './purchase-dispute-machine'

/**
 * Chargeback policy (Joel, 2026-10-09): an open dispute cuts the purchase's
 * access, a won dispute restores it, and a lost dispute keeps it cut and blocks
 * the buyer from future purchases.
 *
 * Access is entitlement rows, not purchase status, so revoking means soft
 * deleting rows. `purchase-dispute-machine.ts` decides which transitions are
 * legal; this file applies one decision per event under a purchase row lock
 * and records it on `purchase.fields.dispute`. The purchase block lives on
 * `user.fields.purchaseBlock`; the existing `Banned` purchase status is not
 * reused because it already marks unrelated seat redemptions.
 */

export { PURCHASE_BLOCKED } from './purchase-block'
export { readDisputeRecord, type PurchaseDisputeRecord }

const DISCORD_ROLE_TYPES = ['cohort_discord_role', 'workshop_discord_role']

export type PurchaseBlock = {
	reason: 'chargeback_lost'
	purchaseId: string
	stripeDisputeId: string
	blockedAt: string
}

type DisputeInput = {
	purchaseId: string
	stripeDisputeId: string
	event: DisputeEventType
	/** What commerce read before writing `Disputed`, from the event. */
	previousStatus?: string
}

type PurchaseRow = typeof purchases.$inferSelect

export function readPurchaseBlock(fields: unknown): PurchaseBlock | undefined {
	const block = (fields as { purchaseBlock?: unknown } | null | undefined)
		?.purchaseBlock
	if (!block || typeof block !== 'object') return undefined
	return block as PurchaseBlock
}

const setJsonField = (
	column: typeof purchases.fields | typeof users.fields,
	path: '$.dispute' | '$.purchaseBlock',
	value: unknown,
) =>
	sql`JSON_SET(COALESCE(${column}, JSON_OBJECT()), ${path}, CAST(${JSON.stringify(value)} AS JSON))`

async function discordRoleTypeIds(executor: DbExecutor) {
	const rows = await executor
		.select({ id: entitlementTypes.id })
		.from(entitlementTypes)
		.where(inArray(entitlementTypes.name, DISCORD_ROLE_TYPES))
	return rows.map((row) => row.id)
}

function discordRoleIdOf(metadata: unknown) {
	const roleId = (metadata as { discordRoleId?: unknown } | null)?.discordRoleId
	return typeof roleId === 'string' && roleId ? roleId : undefined
}

/**
 * Unused credits granted for this product, when the disputed purchase was the
 * user's last paid eligibility. Mirrors the refund rule in refund-entitlements.
 */
async function unusedCreditIdsToRevoke(
	executor: DbExecutor,
	purchase: PurchaseRow,
) {
	if (!purchase.userId) return []
	const surviving = await executor
		.select({ id: purchases.id })
		.from(purchases)
		.where(
			and(
				eq(purchases.userId, purchase.userId),
				eq(purchases.productId, purchase.productId),
				ne(purchases.id, purchase.id),
				inArray(purchases.status, [...ACCESS_STATUSES]),
			),
		)
		.limit(1)
	if (surviving.length > 0) return []

	const credits = await executor
		.select({ id: entitlements.id })
		.from(entitlements)
		.innerJoin(
			entitlementTypes,
			eq(entitlementTypes.id, entitlements.entitlementType),
		)
		.where(
			and(
				eq(entitlementTypes.name, 'apply_special_credit'),
				eq(entitlements.userId, purchase.userId),
				eq(entitlements.sourceType, EntitlementSourceType.COUPON),
				isNull(entitlements.deletedAt),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${entitlements.metadata}, '$.eligibilityProductId')) = ${purchase.productId}`,
			),
		)
		.orderBy(entitlements.id)
	return credits.map((credit) => credit.id)
}

async function cutTargets(
	executor: DbExecutor,
	purchase: PurchaseRow,
	lock: boolean,
) {
	const query = executor
		.select({
			id: entitlements.id,
			entitlementType: entitlements.entitlementType,
			metadata: entitlements.metadata,
		})
		.from(entitlements)
		.where(
			and(
				eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
				eq(entitlements.sourceId, purchase.id),
				isNull(entitlements.deletedAt),
			),
		)
		.orderBy(entitlements.id)
	const active = lock ? await query.for('update') : await query
	const creditIds = await unusedCreditIdsToRevoke(executor, purchase)
	const roleTypes = await discordRoleTypeIds(executor)
	const discordRoleIds = [
		...new Set(
			active.flatMap((row) => {
				const roleId = roleTypes.includes(row.entitlementType)
					? discordRoleIdOf(row.metadata)
					: undefined
				return roleId ? [roleId] : []
			}),
		),
	]
	return {
		entitlementIds: active.map((row) => row.id),
		creditIds,
		discordRoleIds,
	}
}

export type DisputeBuyer =
	| { kind: 'resolved'; userId: string; transferred: boolean }
	| { kind: 'held'; reason: string }

/**
 * The user who paid, which is not always the current owner: a transfer moves
 * the purchase (and its merchant charge and customer) to the recipient. Each
 * completed transfer leaves a `purchaseUserTransfer` row, so the buyer is the
 * first source of an unbroken chain ending at the current owner. Anything
 * else is ambiguous and holds the block for an operator.
 */
export async function resolveDisputeBuyer(
	executor: DbExecutor,
	purchase: Pick<PurchaseRow, 'id' | 'userId'>,
): Promise<DisputeBuyer> {
	if (!purchase.userId) return { kind: 'held', reason: 'no-owner' }
	const transfers = await executor
		.select({
			sourceUserId: purchaseUserTransfer.sourceUserId,
			targetUserId: purchaseUserTransfer.targetUserId,
			completedAt: purchaseUserTransfer.completedAt,
		})
		.from(purchaseUserTransfer)
		.where(
			and(
				eq(purchaseUserTransfer.purchaseId, purchase.id),
				eq(purchaseUserTransfer.transferState, 'COMPLETED'),
			),
		)
		.orderBy(
			asc(purchaseUserTransfer.completedAt),
			asc(purchaseUserTransfer.createdAt),
		)
	if (transfers.length === 0)
		return { kind: 'resolved', userId: purchase.userId, transferred: false }

	const chained = transfers.every(
		(transfer, index) =>
			transfer.completedAt &&
			transfer.targetUserId &&
			(index === 0 ||
				transfer.sourceUserId === transfers[index - 1]!.targetUserId),
	)
	if (!chained || transfers.at(-1)!.targetUserId !== purchase.userId)
		return { kind: 'held', reason: 'transfer-chain-ambiguous' }
	return {
		kind: 'resolved',
		userId: transfers[0]!.sourceUserId,
		transferred: true,
	}
}

async function blockBuyer(
	tx: DbExecutor,
	buyer: DisputeBuyer,
	block: PurchaseBlock,
): Promise<BuyerBlockOutcome> {
	if (buyer.kind === 'held') return { status: 'held', reason: buyer.reason }
	const [user] = await tx
		.select({ id: users.id, fields: users.fields })
		.from(users)
		.where(eq(users.id, buyer.userId))
		.for('update')
	if (!user) return { status: 'held', reason: 'buyer-not-found' }
	const alreadyBlocked = Boolean(readPurchaseBlock(user.fields))
	if (!alreadyBlocked) {
		await tx
			.update(users)
			.set({ fields: setJsonField(users.fields, '$.purchaseBlock', block) })
			.where(eq(users.id, user.id))
	}
	return { status: 'blocked', userId: user.id, alreadyBlocked }
}

export type DisputePlan =
	| { kind: 'purchase-not-found'; purchaseId: string }
	| {
			kind: 'ignored'
			purchaseId: string
			userId: string | null
			status: PurchaseStatus
			reason: string
	  }
	| {
			kind: 'applied' | 'repaired' | 'unchanged'
			purchaseId: string
			userId: string | null
			reason?: string
			status: PurchaseStatus
			plannedStatus: PurchaseStatus
			statusHeld?: string
			from: DisputeState | null
			to: DisputeState
			originalStatus: string | null
			cutEntitlementIds: string[]
			cutCreditEntitlementIds: string[]
			restoreEntitlementIds: string[]
			discordRoleIds: string[]
			buyer: DisputeBuyer | null
			isBulk: boolean
	  }

/** One decision plus the rows it touches. Shared by apply and preview. */
async function planDisputeEvent(
	executor: DbExecutor,
	purchase: PurchaseRow,
	input: DisputeInput,
	lock: boolean,
): Promise<{ plan: DisputePlan; record: PurchaseDisputeRecord | undefined }> {
	const record = readDisputeRecord(purchase.fields)
	const decision = decideDisputeTransition({
		record,
		event: input.event,
		stripeDisputeId: input.stripeDisputeId,
		purchaseStatus: purchase.status,
		eventPreviousStatus: input.previousStatus,
	})
	if (decision.kind === 'ignored')
		return {
			record,
			plan: {
				kind: 'ignored',
				purchaseId: purchase.id,
				userId: purchase.userId,
				status: purchase.status,
				reason: decision.reason,
			},
		}

	const cut = decision.cut
		? await cutTargets(executor, purchase, lock)
		: { entitlementIds: [], creditIds: [], discordRoleIds: [] }
	const restoreEntitlementIds =
		decision.restore && record && record.revokedEntitlementIds.length > 0
			? (
					await executor
						.select({ id: entitlements.id })
						.from(entitlements)
						.where(
							and(
								inArray(entitlements.id, record.revokedEntitlementIds),
								isNotNull(entitlements.deletedAt),
							),
						)
				).map((row) => row.id)
			: []

	return {
		record,
		plan: {
			kind: decision.kind,
			purchaseId: purchase.id,
			userId: purchase.userId,
			...(decision.reason && { reason: decision.reason }),
			status: purchase.status,
			plannedStatus: decision.status ?? purchase.status,
			...(decision.statusHeld && { statusHeld: decision.statusHeld }),
			from: decision.from,
			to: decision.to,
			originalStatus: decision.originalStatus,
			cutEntitlementIds: cut.entitlementIds,
			cutCreditEntitlementIds: cut.creditIds,
			restoreEntitlementIds,
			discordRoleIds: record?.discordRoleIds ?? cut.discordRoleIds,
			buyer: decision.blockBuyer
				? await resolveDisputeBuyer(executor, purchase)
				: null,
			isBulk: Boolean(purchase.bulkCouponId),
		},
	}
}

export type DisputeResult = DisputePlan & {
	record?: PurchaseDisputeRecord
	buyerOutcome?: BuyerBlockOutcome
}

/**
 * Apply one dispute event to a purchase: decide the legal transition, cut or
 * restore rows, persist the record, repair the status and block the buyer, all
 * in one transaction holding the purchase row lock. Safe to replay and to
 * deliver in any order.
 */
export async function applyDisputeEvent({
	now = new Date(),
	...input
}: DisputeInput & { now?: Date }): Promise<DisputeResult> {
	return db.transaction(async (tx): Promise<DisputeResult> => {
		const [purchase] = await tx
			.select()
			.from(purchases)
			.where(eq(purchases.id, input.purchaseId))
			.for('update')
		if (!purchase)
			return { kind: 'purchase-not-found', purchaseId: input.purchaseId }

		const { plan, record } = await planDisputeEvent(tx, purchase, input, true)
		if (plan.kind === 'ignored' || plan.kind === 'purchase-not-found')
			return { ...plan, ...(record && { record }) }
		if (plan.kind === 'unchanged') return { ...plan, record }

		const at = now.toISOString()
		const cutIds = [...plan.cutEntitlementIds, ...plan.cutCreditEntitlementIds]
		if (cutIds.length > 0) {
			await tx
				.update(entitlements)
				.set({ deletedAt: now })
				.where(
					and(inArray(entitlements.id, cutIds), isNull(entitlements.deletedAt)),
				)
		}
		if (plan.restoreEntitlementIds.length > 0) {
			await tx
				.update(entitlements)
				.set({ deletedAt: null })
				.where(inArray(entitlements.id, plan.restoreEntitlementIds))
		}

		const refunded =
			plan.status === 'Refunded' || plan.plannedStatus === 'Refunded'
		let next: PurchaseDisputeRecord = record
			? {
					...record,
					state: plan.to,
					...(plan.to !== plan.from && { closedAt: at }),
					...(refunded && !record.refundedAt && { refundedAt: at }),
				}
			: {
					stripeDisputeId: input.stripeDisputeId,
					state: plan.to,
					originalStatus:
						plan.originalStatus as PurchaseDisputeRecord['originalStatus'],
					openedAt: at,
					...(plan.to !== 'open' && { closedAt: at }),
					...(refunded && { refundedAt: at }),
					revokedEntitlementIds: cutIds,
					discordRoleIds: plan.discordRoleIds,
					discordSync: {},
				}

		let buyerOutcome: BuyerBlockOutcome | undefined
		if (plan.buyer) {
			buyerOutcome = await blockBuyer(tx, plan.buyer, {
				reason: 'chargeback_lost',
				purchaseId: purchase.id,
				stripeDisputeId: input.stripeDisputeId,
				blockedAt: at,
			})
			next = { ...next, buyer: buyerOutcome }
		}

		await tx
			.update(purchases)
			.set({
				...(plan.plannedStatus !== purchase.status && {
					status: plan.plannedStatus,
				}),
				fields: setJsonField(purchases.fields, '$.dispute', next),
			})
			.where(eq(purchases.id, purchase.id))

		return { ...plan, record: next, ...(buyerOutcome && { buyerOutcome }) }
	})
}

/**
 * Read-only plan of what `applyDisputeEvent` would change, from the same
 * planner. Writes nothing and takes no locks.
 */
export async function previewDisputeEvent(
	input: DisputeInput,
	executor: DbExecutor = db,
): Promise<DisputePlan & { buyerAlreadyBlocked?: boolean }> {
	const [purchase] = await executor
		.select()
		.from(purchases)
		.where(eq(purchases.id, input.purchaseId))
	if (!purchase)
		return { kind: 'purchase-not-found', purchaseId: input.purchaseId }
	const { plan } = await planDisputeEvent(executor, purchase, input, false)
	if (
		plan.kind !== 'purchase-not-found' &&
		plan.kind !== 'ignored' &&
		plan.buyer?.kind === 'resolved'
	)
		return {
			...plan,
			buyerAlreadyBlocked: await isUserBlockedFromPurchasing(
				plan.buyer.userId,
				executor,
			),
		}
	return plan
}

/**
 * Record a refund on an existing dispute so it overrides any later outcome,
 * even if a replayed event overwrites the `Refunded` status afterwards.
 */
export async function markPurchaseDisputeRefunded(
	purchaseId: string,
	now = new Date(),
) {
	return db.transaction(async (tx) => {
		const [purchase] = await tx
			.select({ fields: purchases.fields })
			.from(purchases)
			.where(eq(purchases.id, purchaseId))
			.for('update')
		const record = readDisputeRecord(purchase?.fields)
		if (!record || record.refundedAt) return { marked: false }
		await tx
			.update(purchases)
			.set({
				fields: setJsonField(purchases.fields, '$.dispute', {
					...record,
					refundedAt: now.toISOString(),
				}),
			})
			.where(eq(purchases.id, purchaseId))
		return { marked: true }
	})
}

export type DiscordRoleSync =
	| { kind: 'skipped'; reason: string }
	| { kind: 'synced'; roleId: string; result: DiscordRoleSyncResult }

/**
 * Bring one Discord role tied to a dispute in line with the database as it
 * stands now, not with a list cached when an earlier step ran:
 *
 * - No live entitlement grants the role: remove it.
 * - A live grant exists and this dispute removed the role: put it back.
 * - A live grant exists otherwise (another purchase): leave it alone.
 *
 * The purchase row lock is held across the Discord calls so a concurrent win
 * or loss cannot change the answer between the read and the write. Discord
 * failures throw, roll back the result record, and let Inngest retry.
 */
export async function syncDisputeDiscordRole({
	purchaseId,
	stripeDisputeId,
	discordRoleId,
	now = new Date(),
	discord,
}: {
	purchaseId: string
	stripeDisputeId: string
	discordRoleId: string
	now?: Date
	/** Passed in so scripts can import this module outside the Next server. */
	discord: DiscordRoleClient
}): Promise<DiscordRoleSync> {
	return db.transaction(async (tx): Promise<DiscordRoleSync> => {
		const [purchase] = await tx
			.select({ userId: purchases.userId, fields: purchases.fields })
			.from(purchases)
			.where(eq(purchases.id, purchaseId))
			.for('update')
		const record = readDisputeRecord(purchase?.fields)
		if (
			!purchase?.userId ||
			record?.stripeDisputeId !== stripeDisputeId ||
			!record.discordRoleIds.includes(discordRoleId)
		)
			return { kind: 'skipped', reason: 'role-not-tracked' }

		const roleTypes = await discordRoleTypeIds(tx)
		const [grant] = roleTypes.length
			? await tx
					.select({ id: entitlements.id })
					.from(entitlements)
					.where(
						and(
							eq(entitlements.userId, purchase.userId),
							inArray(entitlements.entitlementType, roleTypes),
							isNull(entitlements.deletedAt),
							sql`JSON_UNQUOTE(JSON_EXTRACT(${entitlements.metadata}, '$.discordRoleId')) = ${discordRoleId}`,
						),
					)
					.limit(1)
			: []
		const removedByDispute = ['removed', 'restored'].includes(
			record.discordSync[discordRoleId]?.result ?? '',
		)

		let result: DiscordRoleSyncResult
		if (grant && !removedByDispute) {
			result = 'kept'
		} else {
			const member = await discord.lookupMember(purchase.userId)
			if (member.kind !== 'member') {
				result = 'no-account'
			} else if (grant) {
				if (!member.roles.includes(discordRoleId))
					await discord.addRole(member.discordAccountId, discordRoleId)
				result = 'restored'
			} else if (!member.roles.includes(discordRoleId)) {
				result = 'absent'
			} else {
				await discord.removeRole(member.discordAccountId, discordRoleId)
				result = 'removed'
			}
			if (result === 'restored' || result === 'removed') {
				const after = await discord.lookupMember(purchase.userId)
				const holds =
					after.kind === 'member' && after.roles.includes(discordRoleId)
				if (holds !== (result === 'restored'))
					throw new Error(`discord role ${result} not confirmed by readback`)
			}
		}

		// `absent` after a removal keeps the record of what the dispute took.
		const stored =
			result === 'absent' &&
			record.discordSync[discordRoleId]?.result === 'removed'
				? 'removed'
				: result
		await tx
			.update(purchases)
			.set({
				fields: setJsonField(purchases.fields, '$.dispute', {
					...record,
					discordSync: {
						...record.discordSync,
						[discordRoleId]: { result: stored, at: now.toISOString() },
					},
				}),
			})
			.where(eq(purchases.id, purchaseId))
		return { kind: 'synced', roleId: discordRoleId, result }
	})
}

export type DisputeReadback = {
	purchaseId: string
	status: PurchaseStatus | null
	record: PurchaseDisputeRecord | null
	/** Rows the record says were cut that are live again. */
	liveCutEntitlementIds: string[]
	buyerBlocked: boolean | null
	/** Discord roles with no recorded sync result yet. */
	discordPending: string[]
}

/** Fresh state of a dispute for post-apply readback. */
export async function readDisputeState(
	purchaseId: string,
	executor: DbExecutor = db,
): Promise<DisputeReadback> {
	const [purchase] = await executor
		.select({ status: purchases.status, fields: purchases.fields })
		.from(purchases)
		.where(eq(purchases.id, purchaseId))
	const record = readDisputeRecord(purchase?.fields) ?? null
	const live =
		record && record.revokedEntitlementIds.length > 0
			? await executor
					.select({ id: entitlements.id })
					.from(entitlements)
					.where(
						and(
							inArray(entitlements.id, record.revokedEntitlementIds),
							isNull(entitlements.deletedAt),
						),
					)
			: []
	return {
		purchaseId,
		status: purchase?.status ?? null,
		record,
		liveCutEntitlementIds: live.map((row) => row.id),
		buyerBlocked:
			record?.buyer?.status === 'blocked'
				? await isUserBlockedFromPurchasing(record.buyer.userId, executor)
				: null,
		discordPending: (record?.discordRoleIds ?? []).filter(
			(roleId) => !record?.discordSync[roleId],
		),
	}
}

/** Exact proof the lost event ran, not just a pre-existing block. */
export function lostDisputeConfirmed(
	readback: DisputeReadback,
	stripeDisputeId: string,
) {
	const { record } = readback
	return Boolean(
		record &&
		record.stripeDisputeId === stripeDisputeId &&
		record.state === 'lost' &&
		(readback.status === 'Disputed' || readback.status === 'Refunded') &&
		readback.liveCutEntitlementIds.length === 0 &&
		record.buyer &&
		(record.buyer.status === 'held' || readback.buyerBlocked === true) &&
		readback.discordPending.length === 0,
	)
}

/** True when the user lost a chargeback and may not start a new checkout. */
export async function isUserBlockedFromPurchasing(
	userId: string | null | undefined,
	executor: DbExecutor = db,
) {
	if (!userId) return false
	const [user] = await executor
		.select({ fields: users.fields })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)
	return Boolean(readPurchaseBlock(user?.fields))
}
