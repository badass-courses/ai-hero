import { createHash } from 'node:crypto'
import type {
	organization,
	organizationMemberships,
	organizationMembershipRoles,
	roles,
} from '@/db/schema'

export function compSeatError(
	tag: string,
	did: string,
	why: string,
	fix: string,
) {
	return new Error(
		`${tag}: you ${did}, and it failed because ${why}. Accepted: a reviewed comp-seat plan for existing users and a cohort product. Fix: ${fix}. Debug: inspect the JSON receipt and run a fresh dry-run.`,
	)
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(',')}}`
	return JSON.stringify(value) ?? 'null'
}
export function compSeatPlanHash(plan: unknown): string {
	return createHash('sha256').update(stableJson(plan)).digest('hex')
}
export function compSeatRowId(kind: string, ...parts: string[]): string {
	return `comp-${kind}-${compSeatPlanHash(parts).slice(0, 40)}`
}

export type OrganizationRow =
	| { table: 'organization'; values: typeof organization.$inferInsert }
	| {
			table: 'organizationMemberships'
			values: typeof organizationMemberships.$inferInsert
	  }
	| { table: 'roles'; values: typeof roles.$inferInsert }
	| {
			table: 'organizationMembershipRoles'
			values: typeof organizationMembershipRoles.$inferInsert
	  }
export type CompSeatContext = {
	productId: string
	cohortId: string
	workshopIds: string[]
	contentTypeId: string
	discordTypeId: string | null
	discordRoleId: string | null
}
export type CompSeatUserState = {
	exists: boolean
	existingPurchaseId: string | null
	organizationId: string
	membershipId: string
	organizationRows: OrganizationRow[]
}
export type CompSeatEntitlement = {
	id: string
	userId: string
	organizationId: string
	organizationMembershipId: string
	entitlementType: string
	sourceType: 'PURCHASE'
	sourceId: string
	metadata: {
		cohortId: string
		earlyAccess: true
		contentIds?: string[]
		discordRoleId?: string
	}
}
export type CompSeatDiscordEvent = {
	id: string
	name: 'cohort/user-added'
	data: { userId: string; cohortId: string; discordRoleId: string }
}
export type CompSeatUserPlan = {
	userId: string
	outcome: 'create' | 'skipped_existing_purchase'
	existingPurchaseId: string | null
	organizationRows: OrganizationRow[]
	purchase: {
		id: string
		userId: string
		productId: string
		status: 'Valid'
		totalAmount: '0'
		organizationId: string
		purchasedByorganizationMembershipId: string
		fields: { source: 'comp'; reason: string; earlyAccess: true }
	} | null
	entitlements: CompSeatEntitlement[]
	discord: 'configured' | 'not_configured'
	discordEvent: CompSeatDiscordEvent | null
}
export type CompSeatPlan = {
	version: 1
	productId: string
	reason: string
	context: CompSeatContext
	users: CompSeatUserPlan[]
}
type Reader = {
	context(productId: string): Promise<CompSeatContext>
	userState(userId: string, productId: string): Promise<CompSeatUserState>
}
export type CompSeatRepository = Reader & {
	transaction<T>(
		userId: string,
		operation: (
			tx: Reader & { write(plan: CompSeatUserPlan): Promise<void> },
		) => Promise<T>,
	): Promise<T>
	send(event: CompSeatDiscordEvent): Promise<void>
}

function userPlan(
	context: CompSeatContext,
	userId: string,
	state: CompSeatUserState,
	reason: string,
): CompSeatUserPlan {
	if (!state.exists)
		throw compSeatError(
			'UserMissing',
			'planned a grant',
			'a requested user does not exist',
			'correct the input file',
		)
	const base = {
		userId,
		existingPurchaseId: state.existingPurchaseId,
		discord: context.discordRoleId
			? ('configured' as const)
			: ('not_configured' as const),
	}
	if (state.existingPurchaseId)
		return {
			...base,
			outcome: 'skipped_existing_purchase',
			organizationRows: [],
			purchase: null,
			entitlements: [],
			discordEvent: null,
		}
	const purchaseId = compSeatRowId('purchase', context.productId, userId)
	const common = {
		userId,
		organizationId: state.organizationId,
		organizationMembershipId: state.membershipId,
		sourceType: 'PURCHASE' as const,
		sourceId: purchaseId,
	}
	const entitlements: CompSeatEntitlement[] = [...new Set(context.workshopIds)]
		.sort()
		.map((workshopId) => ({
			...common,
			id: compSeatRowId('content', purchaseId, workshopId),
			entitlementType: context.contentTypeId,
			metadata: {
				cohortId: context.cohortId,
				contentIds: [workshopId],
				earlyAccess: true,
			},
		}))
	// Enrollment anchor lets the existing JOIN-based sync find an empty cohort.
	// It grants no module access and survives until workshops are added later.
	if (!entitlements.length)
		entitlements.push({
			...common,
			id: compSeatRowId('enrollment', purchaseId),
			entitlementType: context.contentTypeId,
			metadata: {
				cohortId: context.cohortId,
				contentIds: [],
				earlyAccess: true,
			},
		})
	let discordEvent: CompSeatDiscordEvent | null = null
	if (context.discordRoleId) {
		if (!context.discordTypeId)
			throw compSeatError(
				'EntitlementTypeMissing',
				'planned Discord access',
				'the cohort Discord entitlement type is missing',
				'seed the entitlement type',
			)
		entitlements.push({
			...common,
			id: compSeatRowId('discord', purchaseId),
			entitlementType: context.discordTypeId,
			metadata: {
				cohortId: context.cohortId,
				discordRoleId: context.discordRoleId,
				earlyAccess: true,
			},
		})
		discordEvent = {
			id: compSeatRowId('discord-event', purchaseId),
			name: 'cohort/user-added',
			data: {
				userId,
				cohortId: context.cohortId,
				discordRoleId: context.discordRoleId,
			},
		}
	}
	return {
		...base,
		outcome: 'create',
		organizationRows: state.organizationRows,
		purchase: {
			id: purchaseId,
			userId,
			productId: context.productId,
			status: 'Valid',
			totalAmount: '0',
			organizationId: state.organizationId,
			purchasedByorganizationMembershipId: state.membershipId,
			fields: { source: 'comp', reason, earlyAccess: true },
		},
		entitlements,
		discordEvent,
	}
}

export async function buildCompSeatPlan(
	repository: Reader,
	productId: string,
	userIds: string[],
	reason: string,
): Promise<CompSeatPlan> {
	if (!productId || !reason.trim() || !userIds.length)
		throw compSeatError(
			'InvalidInput',
			'planned a grant',
			'product, reason or user ids are missing',
			'provide --product-id, --user-ids and --reason',
		)
	const context = await repository.context(productId)
	const normalized = {
		...context,
		workshopIds: [...new Set(context.workshopIds)].sort(),
	}
	const users: CompSeatUserPlan[] = []
	for (const userId of [...new Set(userIds)].sort())
		users.push(
			userPlan(
				normalized,
				userId,
				await repository.userState(userId, productId),
				reason,
			),
		)
	return { version: 1, productId, reason, context: normalized, users }
}

export const COMP_SEAT_ROLLBACK =
	'Delete the comp purchase and its sourceId-linked entitlements; or clear earlyAccess on both purchase fields and entitlement metadata (including later synced entitlements). Keep shared personal organizations and memberships.'
export function compSeatReceipt(plan: CompSeatPlan) {
	return {
		version: 1,
		mode: 'dry-run' as 'dry-run' | 'execute',
		planHash: compSeatPlanHash(plan),
		plan,
		counts: {
			planned: plan.users.filter((user) => user.outcome === 'create').length,
			created: 0,
			skipped: plan.users.filter(
				(user) => user.outcome === 'skipped_existing_purchase',
			).length,
			failed: 0,
		},
		users: plan.users.map((user) => ({
			userId: user.userId,
			outcome: user.outcome as string,
			discord: user.discord as string,
			error: null as string | null,
		})),
		rollback: COMP_SEAT_ROLLBACK,
	}
}

export async function executeCompSeatPlan(
	repository: CompSeatRepository,
	plan: CompSeatPlan,
	approvedHash: string | undefined,
) {
	if (approvedHash !== compSeatPlanHash(plan))
		throw compSeatError(
			'PlanMismatch',
			'executed a grant',
			'the plan hash does not match the dry-run',
			'review a fresh dry-run and pass --plan-hash <hash>',
		)
	const receipt = compSeatReceipt(plan)
	receipt.mode = 'execute'
	for (const [index, planned] of plan.users.entries()) {
		if (planned.outcome !== 'create') continue
		try {
			const created = await repository.transaction(
				planned.userId,
				async (tx) => {
					const fresh = await buildCompSeatPlan(
						tx,
						plan.productId,
						[planned.userId],
						plan.reason,
					)
					// Another grant may have committed while this process waited for
					// the user lock. Skipping needs no additional write approval.
					if (fresh.users[0]!.outcome === 'skipped_existing_purchase')
						return false
					if (
						compSeatPlanHash(fresh.context) !==
							compSeatPlanHash(plan.context) ||
						compSeatPlanHash(fresh.users[0]) !== compSeatPlanHash(planned)
					)
						throw compSeatError(
							'PlanMismatch',
							'executed a user grant',
							'the user or cohort changed after planning',
							'review a fresh dry-run',
						)
					await tx.write(planned)
					return true
				},
			)
			if (!created) {
				receipt.counts.skipped++
				receipt.users[index]!.outcome = 'skipped_existing_purchase'
				continue
			}
			receipt.counts.created++
			receipt.users[index]!.outcome = 'created'
		} catch (error) {
			receipt.counts.failed++
			receipt.users[index]!.outcome = 'failed'
			receipt.users[index]!.error =
				error instanceof Error && error.message.startsWith('PlanMismatch: you ')
					? error.message
					: compSeatError(
							'TransactionFailed',
							'executed a user grant',
							'the transaction did not commit',
							'check the database and dry-run the remaining users',
						).message
			continue
		}
		if (planned.discordEvent) {
			try {
				await repository.send(planned.discordEvent)
				receipt.users[index]!.discord = 'sent'
			} catch {
				receipt.users[index]!.discord = 'delivery_failed'
				receipt.users[index]!.error = compSeatError(
					'DiscordDeliveryFailed',
					'sent the cohort role event',
					'event delivery failed after the grant committed',
					'verify the grant and resend the exact discordEvent from this plan; do not repeat purchase creation',
				).message
			}
		}
	}
	return receipt
}
