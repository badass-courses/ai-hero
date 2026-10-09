import { db, type DbExecutor } from '@/db'
import { entitlements, entitlementTypes, purchases, users } from '@/db/schema'
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'

import { EntitlementSourceType } from './entitlements'

/**
 * Chargeback policy (Joel, 2026-10-09): an open dispute cuts the purchase's
 * access, a won dispute restores it, and a lost dispute keeps it cut and blocks
 * the buyer from future purchases.
 *
 * Access is entitlement rows, not purchase status, so revoking means soft
 * deleting rows. The exact rows and the pre-dispute status are recorded on
 * `purchase.fields.dispute` so a win can restore precisely what was taken.
 * The purchase block lives on `user.fields.purchaseBlock`; the existing
 * `Banned` purchase status is not reused because it already marks unrelated
 * seat redemptions.
 */

export { PURCHASE_BLOCKED } from './purchase-block'

const RESTORABLE_STATUSES = ['Valid', 'Restricted'] as const
type RestorableStatus = (typeof RESTORABLE_STATUSES)[number]

const isRestorableStatus = (status: unknown): status is RestorableStatus =>
	RESTORABLE_STATUSES.includes(status as RestorableStatus)

const DISCORD_ROLE_TYPES = ['cohort_discord_role', 'workshop_discord_role']

export type PurchaseDisputeRecord = {
	stripeDisputeId: string
	previousStatus: RestorableStatus
	revokedAt: string
	revokedEntitlementIds: string[]
	outcome?: 'won' | 'lost'
	closedAt?: string
}

export type PurchaseBlock = {
	reason: 'chargeback_lost'
	purchaseId: string
	stripeDisputeId: string
	blockedAt: string
}

export type DiscordRoleGrant = {
	entitlementId: string
	discordRoleId: string
	kind: 'cohort' | 'workshop'
}

export type DisputeRevocation =
	| {
			kind: 'revoked'
			purchaseId: string
			userId: string | null
			record: PurchaseDisputeRecord
			discordRoles: DiscordRoleGrant[]
			isBulk: boolean
	  }
	| {
			kind: 'already-revoked'
			purchaseId: string
			record: PurchaseDisputeRecord
	  }
	| { kind: 'skipped'; purchaseId: string; reason: string }
	| { kind: 'purchase-not-found'; purchaseId: string }

export type DisputeRestoration =
	| {
			kind: 'restored'
			purchaseId: string
			userId: string | null
			record: PurchaseDisputeRecord
			restoredEntitlementIds: string[]
			discordRoles: DiscordRoleGrant[]
	  }
	| { kind: 'skipped'; purchaseId: string; reason: string }
	| { kind: 'purchase-not-found'; purchaseId: string }

export type DisputeLoss =
	| {
			kind: 'blocked'
			purchaseId: string
			userId: string
			revocation: DisputeRevocation
			block: PurchaseBlock
			alreadyBlocked: boolean
	  }
	| { kind: 'skipped'; purchaseId: string; reason: string }

type DisputeInput = {
	purchaseId: string
	stripeDisputeId: string
}

export function readDisputeRecord(
	fields: unknown,
): PurchaseDisputeRecord | undefined {
	const record = (fields as { dispute?: unknown } | null | undefined)?.dispute
	if (!record || typeof record !== 'object') return undefined
	const candidate = record as Partial<PurchaseDisputeRecord>
	if (
		typeof candidate.stripeDisputeId !== 'string' ||
		!isRestorableStatus(candidate.previousStatus) ||
		typeof candidate.revokedAt !== 'string' ||
		!Array.isArray(candidate.revokedEntitlementIds)
	)
		return undefined
	return candidate as PurchaseDisputeRecord
}

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
		.select({ id: entitlementTypes.id, name: entitlementTypes.name })
		.from(entitlementTypes)
		.where(inArray(entitlementTypes.name, DISCORD_ROLE_TYPES))
	return new Map(
		rows.map((row) => [
			row.id,
			row.name === 'cohort_discord_role' ? 'cohort' : 'workshop',
		]),
	) as Map<string, DiscordRoleGrant['kind']>
}

function discordRolesFor(
	rows: { id: string; entitlementType: string; metadata: unknown }[],
	roleTypes: Map<string, DiscordRoleGrant['kind']>,
): DiscordRoleGrant[] {
	return rows.flatMap((row) => {
		const kind = roleTypes.get(row.entitlementType)
		const discordRoleId = (row.metadata as { discordRoleId?: unknown } | null)
			?.discordRoleId
		if (!kind || typeof discordRoleId !== 'string' || !discordRoleId) return []
		return [{ entitlementId: row.id, discordRoleId, kind }]
	})
}

/**
 * Unused credits granted for this product, when the disputed purchase was the
 * user's last paid eligibility. Mirrors the refund rule in refund-entitlements.
 */
async function unusedCreditIdsToRevoke(
	executor: DbExecutor,
	purchase: { id: string; userId: string | null; productId: string },
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
				inArray(purchases.status, [...RESTORABLE_STATUSES]),
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

/**
 * The status a win restores, or undefined when the purchase already lost
 * access another way (Refunded, Banned) and must not be touched.
 */
function restoreStatusFor(
	status: string,
	previousStatus: string | undefined,
): RestorableStatus | undefined {
	if (isRestorableStatus(status)) return status
	// Commerce marked it Disputed before telling us; trust what it read.
	if (status === 'Disputed')
		return isRestorableStatus(previousStatus) ? previousStatus : 'Valid'
	return undefined
}

async function revocationTargets(
	executor: DbExecutor,
	purchase: { id: string; userId: string | null; productId: string },
	lock = true,
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
	return {
		active,
		creditIds,
		revokedEntitlementIds: [...active.map((row) => row.id), ...creditIds],
	}
}

export type LostDisputePreview =
	| { kind: 'purchase-not-found'; purchaseId: string }
	| {
			kind: 'planned'
			purchaseId: string
			userId: string | null
			status: string
			plannedStatus: string
			restoreStatus: RestorableStatus | null
			alreadyRevoked: boolean
			revokeEntitlementIds: string[]
			revokeCreditEntitlementIds: string[]
			discordRoleEntitlementIds: string[]
			userAlreadyBlocked: boolean
	  }

/**
 * Read-only plan of what `applyLostDispute` would change, from the same
 * selection rules. Writes nothing and takes no locks.
 */
export async function previewLostDispute(
	{
		purchaseId,
		stripeDisputeId,
		previousStatus,
	}: DisputeInput & { previousStatus?: string },
	executor: DbExecutor = db,
): Promise<LostDisputePreview> {
	const [purchase] = await executor
		.select()
		.from(purchases)
		.where(eq(purchases.id, purchaseId))
	if (!purchase) return { kind: 'purchase-not-found', purchaseId }

	const alreadyRevoked =
		readDisputeRecord(purchase.fields)?.stripeDisputeId === stripeDisputeId
	const restoreStatus = alreadyRevoked
		? null
		: (restoreStatusFor(purchase.status, previousStatus) ?? null)
	const targets = restoreStatus
		? await revocationTargets(executor, purchase, false)
		: { active: [], creditIds: [] }
	const roleTypes = await discordRoleTypeIds(executor)

	return {
		kind: 'planned',
		purchaseId,
		userId: purchase.userId,
		status: purchase.status,
		plannedStatus: restoreStatus ? 'Disputed' : purchase.status,
		restoreStatus,
		alreadyRevoked,
		revokeEntitlementIds: targets.active.map((row) => row.id),
		revokeCreditEntitlementIds: targets.creditIds,
		discordRoleEntitlementIds: discordRolesFor(targets.active, roleTypes).map(
			(role) => role.entitlementId,
		),
		userAlreadyBlocked: await isUserBlockedFromPurchasing(
			purchase.userId,
			executor,
		),
	}
}

/**
 * Cut a disputed purchase's access and record what was cut. Idempotent per
 * dispute: a retry or a later lost-close for the same dispute is a no-op.
 *
 * A `Valid` or `Restricted` purchase is marked `Disputed` here too, so a
 * dispute opened before the commerce fix (never marked) is handled the same
 * way. `Refunded` and `Banned` purchases already lost access and are skipped.
 */
export async function revokeDisputedPurchaseAccess({
	purchaseId,
	stripeDisputeId,
	previousStatus,
	now = new Date(),
}: DisputeInput & { previousStatus?: string; now?: Date }) {
	return db.transaction(async (tx): Promise<DisputeRevocation> => {
		const [purchase] = await tx
			.select()
			.from(purchases)
			.where(eq(purchases.id, purchaseId))
			.for('update')
		if (!purchase) return { kind: 'purchase-not-found', purchaseId }

		const existing = readDisputeRecord(purchase.fields)
		if (existing?.stripeDisputeId === stripeDisputeId) {
			return { kind: 'already-revoked', purchaseId, record: existing }
		}

		const restoreTo = restoreStatusFor(purchase.status, previousStatus)
		if (!restoreTo) {
			return {
				kind: 'skipped',
				purchaseId,
				reason: `status-${purchase.status}`,
			}
		}

		const { active, revokedEntitlementIds } = await revocationTargets(
			tx,
			purchase,
		)

		if (revokedEntitlementIds.length > 0) {
			await tx
				.update(entitlements)
				.set({ deletedAt: now })
				.where(
					and(
						inArray(entitlements.id, revokedEntitlementIds),
						isNull(entitlements.deletedAt),
					),
				)
		}

		const record: PurchaseDisputeRecord = {
			stripeDisputeId,
			previousStatus: restoreTo,
			revokedAt: now.toISOString(),
			revokedEntitlementIds,
		}
		await tx
			.update(purchases)
			.set({
				status: 'Disputed',
				fields: setJsonField(purchases.fields, '$.dispute', record),
			})
			.where(eq(purchases.id, purchase.id))

		return {
			kind: 'revoked',
			purchaseId,
			userId: purchase.userId,
			record,
			discordRoles: discordRolesFor(active, await discordRoleTypeIds(tx)),
			isBulk: Boolean(purchase.bulkCouponId),
		}
	})
}

/**
 * A won dispute puts back exactly what the revocation recorded: the
 * pre-dispute status and the soft-deleted entitlement rows.
 */
export async function restoreDisputedPurchaseAccess({
	purchaseId,
	stripeDisputeId,
	now = new Date(),
}: DisputeInput & { now?: Date }) {
	return db.transaction(async (tx): Promise<DisputeRestoration> => {
		const [purchase] = await tx
			.select()
			.from(purchases)
			.where(eq(purchases.id, purchaseId))
			.for('update')
		if (!purchase) return { kind: 'purchase-not-found', purchaseId }

		const record = readDisputeRecord(purchase.fields)
		if (!record) return { kind: 'skipped', purchaseId, reason: 'no-record' }
		if (record.stripeDisputeId !== stripeDisputeId)
			return { kind: 'skipped', purchaseId, reason: 'different-dispute' }
		if (record.outcome)
			return { kind: 'skipped', purchaseId, reason: `closed-${record.outcome}` }
		if (purchase.status !== 'Disputed')
			return {
				kind: 'skipped',
				purchaseId,
				reason: `status-${purchase.status}`,
			}

		const restorable =
			record.revokedEntitlementIds.length > 0
				? await tx
						.select({
							id: entitlements.id,
							entitlementType: entitlements.entitlementType,
							metadata: entitlements.metadata,
						})
						.from(entitlements)
						.where(
							and(
								inArray(entitlements.id, record.revokedEntitlementIds),
								isNotNull(entitlements.deletedAt),
							),
						)
						.for('update')
				: []
		const restoredEntitlementIds = restorable.map((row) => row.id)
		if (restoredEntitlementIds.length > 0) {
			await tx
				.update(entitlements)
				.set({ deletedAt: null })
				.where(inArray(entitlements.id, restoredEntitlementIds))
		}

		const closed: PurchaseDisputeRecord = {
			...record,
			outcome: 'won',
			closedAt: now.toISOString(),
		}
		await tx
			.update(purchases)
			.set({
				status: record.previousStatus,
				fields: setJsonField(purchases.fields, '$.dispute', closed),
			})
			.where(eq(purchases.id, purchase.id))

		return {
			kind: 'restored',
			purchaseId,
			userId: purchase.userId,
			record: closed,
			restoredEntitlementIds,
			discordRoles: discordRolesFor(restorable, await discordRoleTypeIds(tx)),
		}
	})
}

/**
 * A lost dispute keeps the purchase cut off (revoking first if the open event
 * never arrived) and blocks the purchasing user from future checkouts.
 */
export async function applyLostDispute({
	purchaseId,
	stripeDisputeId,
	previousStatus,
	now = new Date(),
}: DisputeInput & {
	previousStatus?: string
	now?: Date
}): Promise<DisputeLoss> {
	const revocation = await revokeDisputedPurchaseAccess({
		purchaseId,
		stripeDisputeId,
		previousStatus,
		now,
	})
	if (revocation.kind === 'purchase-not-found')
		return { kind: 'skipped', purchaseId, reason: 'purchase-not-found' }

	return db.transaction(async (tx): Promise<DisputeLoss> => {
		const [purchase] = await tx
			.select()
			.from(purchases)
			.where(eq(purchases.id, purchaseId))
			.for('update')
		if (!purchase?.userId)
			return { kind: 'skipped', purchaseId, reason: 'no-user' }

		const record = readDisputeRecord(purchase.fields)
		if (record?.stripeDisputeId === stripeDisputeId && !record.outcome) {
			await tx
				.update(purchases)
				.set({
					fields: setJsonField(purchases.fields, '$.dispute', {
						...record,
						outcome: 'lost',
						closedAt: now.toISOString(),
					}),
				})
				.where(eq(purchases.id, purchase.id))
		}

		const [user] = await tx
			.select({ id: users.id, fields: users.fields })
			.from(users)
			.where(eq(users.id, purchase.userId))
			.for('update')
		if (!user) return { kind: 'skipped', purchaseId, reason: 'user-not-found' }

		const existingBlock = readPurchaseBlock(user.fields)
		const block: PurchaseBlock = existingBlock ?? {
			reason: 'chargeback_lost',
			purchaseId,
			stripeDisputeId,
			blockedAt: now.toISOString(),
		}
		if (!existingBlock) {
			await tx
				.update(users)
				.set({
					fields: setJsonField(users.fields, '$.purchaseBlock', block),
				})
				.where(eq(users.id, user.id))
		}

		return {
			kind: 'blocked',
			purchaseId,
			userId: user.id,
			revocation,
			block,
			alreadyBlocked: Boolean(existingBlock),
		}
	})
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
