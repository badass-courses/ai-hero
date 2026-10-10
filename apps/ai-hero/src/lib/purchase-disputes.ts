import { db, type DbExecutor } from '@/db'
import {
	entitlements,
	entitlementTypes,
	merchantCharge,
	purchases,
	purchaseUserTransfer,
	users,
} from '@/db/schema'
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'

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

/** Transfer states in which ownership has moved to the target. */
const HANDOFF_TRANSFER_STATES = ['VERIFIED', 'CONFIRMED', 'COMPLETED']
/** Transfer states in which ownership has not moved. */
const NON_HANDOFF_TRANSFER_STATES = [
	'AVAILABLE',
	'INITIATED',
	'CANCELED',
	'EXPIRED',
]

/**
 * The user who paid, which is not always the current owner: a transfer moves
 * the purchase to the recipient. Support transfers commit the new owner with
 * a VERIFIED row and mark it COMPLETED later; legacy rows carry CONFIRMED.
 * All three are handoffs. The buyer is the first source of an unbroken chain
 * of handoffs ending at the current owner.
 *
 * Every transfer row is read and classified, so a filter can never turn
 * history into "no history". With no rows at all, the owner is the buyer
 * only if the merchant charge still names them. Anything else holds the
 * block for an operator, and a held block is retried on later events.
 */
export async function resolveDisputeBuyer(
	executor: DbExecutor,
	purchase: Pick<PurchaseRow, 'id' | 'userId' | 'merchantChargeId'>,
): Promise<DisputeBuyer> {
	if (!purchase.userId) return { kind: 'held', reason: 'no-owner' }
	const rows = await executor
		.select({
			transferState: purchaseUserTransfer.transferState,
			sourceUserId: purchaseUserTransfer.sourceUserId,
			targetUserId: purchaseUserTransfer.targetUserId,
			createdAt: purchaseUserTransfer.createdAt,
			confirmedAt: purchaseUserTransfer.confirmedAt,
			completedAt: purchaseUserTransfer.completedAt,
		})
		.from(purchaseUserTransfer)
		.where(eq(purchaseUserTransfer.purchaseId, purchase.id))

	if (
		rows.some(
			(row) =>
				!HANDOFF_TRANSFER_STATES.includes(row.transferState) &&
				!NON_HANDOFF_TRANSFER_STATES.includes(row.transferState),
		)
	)
		return { kind: 'held', reason: 'transfer-state-unknown' }

	const handoffs = rows
		.filter((row) => HANDOFF_TRANSFER_STATES.includes(row.transferState))
		.map((row) => ({
			...row,
			at: (row.completedAt ?? row.confirmedAt ?? row.createdAt)?.getTime(),
		}))
		.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

	if (handoffs.length === 0) {
		if (rows.length === 0 && purchase.merchantChargeId) {
			const [charge] = await executor
				.select({ userId: merchantCharge.userId })
				.from(merchantCharge)
				.where(eq(merchantCharge.id, purchase.merchantChargeId))
			if (!charge || charge.userId !== purchase.userId)
				return { kind: 'held', reason: 'charge-owner-mismatch' }
		}
		return { kind: 'resolved', userId: purchase.userId, transferred: false }
	}

	const chained = handoffs.every(
		(handoff, index) =>
			handoff.at !== undefined &&
			handoff.targetUserId &&
			(index === 0 ||
				handoff.sourceUserId === handoffs[index - 1]!.targetUserId),
	)
	if (!chained || handoffs.at(-1)!.targetUserId !== purchase.userId)
		return { kind: 'held', reason: 'transfer-chain-ambiguous' }
	return {
		kind: 'resolved',
		userId: handoffs[0]!.sourceUserId,
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
			restoreHeld?: string
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
			...(decision.restoreHeld && { restoreHeld: decision.restoreHeld }),
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
					originalStatus:
						plan.originalStatus as PurchaseDisputeRecord['originalStatus'],
					...(plan.to !== plan.from && { closedAt: at }),
					...(refunded && !record.refundedAt && { refundedAt: at }),
					...(plan.status === 'Banned' && !record.bannedAt && { bannedAt: at }),
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
	| {
			kind: 'synced'
			roleId: string
			result: DiscordRoleSyncResult
			verified: boolean
	  }

/** What the database says one role should be, read under the row lock. */
async function discordRolePlan(
	tx: DbExecutor,
	purchaseId: string,
	stripeDisputeId: string,
	discordRoleId: string,
) {
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
		return null

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
	// A recorded removal, or an attempted one whose outcome was never recorded.
	const removedByDispute =
		['removed', 'restored'].includes(
			record.discordSync[discordRoleId]?.result ?? '',
		) || record.discordAttempts?.[discordRoleId]?.action === 'remove'
	return {
		userId: purchase.userId,
		record,
		granted: Boolean(grant),
		removedByDispute,
	}
}

async function writeDisputeRecord(
	tx: DbExecutor,
	purchaseId: string,
	record: PurchaseDisputeRecord,
) {
	await tx
		.update(purchases)
		.set({ fields: setJsonField(purchases.fields, '$.dispute', record) })
		.where(eq(purchases.id, purchaseId))
}

/**
 * Bring one Discord role tied to a dispute in line with the database as it
 * stands now, not with a list cached when an earlier step ran:
 *
 * - No live entitlement grants the role: remove it.
 * - A live grant exists and this dispute removed the role: put it back.
 * - A live grant exists otherwise (another purchase): leave it alone.
 *
 * Discord is outside the database transaction, so a change is recorded as an
 * attempt and committed before the remote call. If Discord applies it and
 * anything after fails, the retry still knows this dispute removed the role.
 * The result is written in a fresh locked transaction that rechecks the plan;
 * if a win or loss landed meanwhile it throws, and the retry converges.
 * A failed readback after an accepted change records the result as
 * unverified, which stays pending until a later sync verifies it.
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
	const at = now.toISOString()
	const plan = await db.transaction((tx) =>
		discordRolePlan(tx, purchaseId, stripeDisputeId, discordRoleId),
	)
	if (!plan) return { kind: 'skipped', reason: 'role-not-tracked' }

	let result: DiscordRoleSyncResult
	let verified = true
	if (plan.granted && !plan.removedByDispute) {
		result = 'kept'
	} else {
		const member = await discord.lookupMember(plan.userId)
		const holds =
			member.kind === 'member' && member.roles.includes(discordRoleId)
		const action =
			member.kind !== 'member'
				? null
				: plan.granted
					? holds
						? null
						: 'add'
					: holds
						? 'remove'
						: null
		result =
			member.kind !== 'member'
				? 'no-account'
				: plan.granted
					? 'restored'
					: action === 'remove'
						? 'removed'
						: 'absent'

		if (member.kind === 'member' && action) {
			await db.transaction(async (tx) => {
				const current = await discordRolePlan(
					tx,
					purchaseId,
					stripeDisputeId,
					discordRoleId,
				)
				if (!current || current.granted !== plan.granted)
					throw new Error('dispute changed during discord sync; retrying')
				await writeDisputeRecord(tx, purchaseId, {
					...current.record,
					discordAttempts: {
						...current.record.discordAttempts,
						[discordRoleId]: { action, at },
					},
				})
			})
			if (action === 'add')
				await discord.addRole(member.discordAccountId, discordRoleId)
			else await discord.removeRole(member.discordAccountId, discordRoleId)

			// A failed readback leaves the accepted change unverified. A readback
			// that contradicts it throws; the committed attempt keeps provenance.
			const after = await discord.lookupMember(plan.userId).catch(() => null)
			verified = Boolean(after)
			const holdsAfter =
				after?.kind === 'member' && after.roles.includes(discordRoleId)
			if (after && holdsAfter !== (action === 'add'))
				throw new Error(`discord role ${result} not confirmed by readback`)
		}
	}

	await db.transaction(async (tx) => {
		const current = await discordRolePlan(
			tx,
			purchaseId,
			stripeDisputeId,
			discordRoleId,
		)
		if (!current) return
		if (current.granted !== plan.granted)
			throw new Error('dispute changed during discord sync; retrying')
		// `absent` after this dispute removed the role keeps the provenance.
		const stored =
			result === 'absent' && current.removedByDispute ? 'removed' : result
		const { [discordRoleId]: _settled, ...attempts } =
			current.record.discordAttempts ?? {}
		const { discordAttempts: _previous, ...rest } = current.record
		await writeDisputeRecord(tx, purchaseId, {
			...rest,
			...(Object.keys(attempts).length > 0 && { discordAttempts: attempts }),
			discordSync: {
				...current.record.discordSync,
				[discordRoleId]: {
					result: stored,
					at,
					...(!verified && { unverified: true as const }),
				},
			},
		})
	})
	return { kind: 'synced', roleId: discordRoleId, result, verified }
}

export type DisputeReadback = {
	purchaseId: string
	status: PurchaseStatus | null
	record: PurchaseDisputeRecord | null
	/** Rows the record says were cut that are live again. */
	liveCutEntitlementIds: string[]
	buyerBlocked: boolean | null
	/** Discord roles with no verified sync result yet. */
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
			(roleId) =>
				!record?.discordSync[roleId] ||
				record.discordSync[roleId]!.unverified ||
				record.discordAttempts?.[roleId],
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
