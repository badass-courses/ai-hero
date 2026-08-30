import { closeDatabasePool, db } from '@/db'
import { purchases } from '@/db/schema'
import {
	drizzleTeamPurchaseFulfillmentDataSource,
	reconcileTeamPurchaseFulfillment,
	type TeamPurchaseFulfillmentDataSource,
	type TeamPurchaseFulfillmentResult,
	type TeamPurchaseLinkInput,
} from '@/lib/team-purchase-fulfillment'
import { getTeamPurchasesForMember } from '@/lib/team-purchases'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export type RepairArgs = {
	purchaseIds: string[]
	allowWrite: boolean
	confirmCount: number | null
	receiptPath: string
}

function loadApprovedPurchaseIds(): string[] {
	const approvedIds = [
		process.env.AIH_TEAM_PURCHASE_REPAIR_CASE_A_ID,
		process.env.AIH_TEAM_PURCHASE_REPAIR_CASE_B_ID,
	].filter((value): value is string => Boolean(value))
	if (approvedIds.length !== 2 || new Set(approvedIds).size !== 2) {
		throw new Error(
			'The two approved historical purchase IDs must be configured',
		)
	}
	return approvedIds
}

export function parseRepairArgs(
	args: string[],
	approvedPurchaseIds: string[] = loadApprovedPurchaseIds(),
): RepairArgs {
	const purchaseIds: string[] = []
	let allowWrite = false
	let confirmCount: number | null = null
	let receiptPath = `/tmp/ai-hero-team-purchase-link-repair-${Date.now()}.json`

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!
		if (argument === '--allow-write') {
			allowWrite = true
			continue
		}
		if (argument === '--purchase-id') {
			const value = args[index + 1]
			if (!value) throw new Error('--purchase-id requires a value')
			purchaseIds.push(value)
			index += 1
			continue
		}
		if (argument.startsWith('--purchase-id=')) {
			purchaseIds.push(argument.slice('--purchase-id='.length))
			continue
		}
		if (argument === '--confirm-count') {
			const value = Number(args[index + 1])
			if (!Number.isInteger(value) || value < 1) {
				throw new Error('--confirm-count requires a positive integer')
			}
			confirmCount = value
			index += 1
			continue
		}
		if (argument === '--receipt') {
			const value = args[index + 1]
			if (!value) throw new Error('--receipt requires a path')
			receiptPath = value
			index += 1
			continue
		}
		throw new Error(`Unknown argument: ${argument}`)
	}

	const uniquePurchaseIds = Array.from(new Set(purchaseIds))
	if (uniquePurchaseIds.length === 0) {
		throw new Error('At least one --purchase-id is required')
	}
	const approvedSet = new Set(approvedPurchaseIds)
	if (uniquePurchaseIds.some((purchaseId) => !approvedSet.has(purchaseId))) {
		throw new Error('Purchase allowlist contains an unapproved ID')
	}
	if (allowWrite && confirmCount !== uniquePurchaseIds.length) {
		throw new Error(
			'--allow-write requires --confirm-count to match the purchase allowlist',
		)
	}

	return {
		purchaseIds: uniquePurchaseIds,
		allowWrite,
		confirmCount,
		receiptPath,
	}
}

type Readback = {
	userId: string | null
	organizationId: string | null
	organizationMembershipId: string | null
	bulkCouponOrganizationId: string | null
	maxUses: number | null
	usedCount: number | null
}

async function loadReadback(purchaseId: string): Promise<Readback | null> {
	const purchase = await db.query.purchases.findFirst({
		where: eq(purchases.id, purchaseId),
		with: { bulkCoupon: true },
	})
	if (!purchase) return null
	return {
		userId: purchase.userId,
		organizationId: purchase.organizationId,
		organizationMembershipId:
			purchase.purchasedByorganizationMembershipId,
		bulkCouponOrganizationId: purchase.bulkCoupon?.organizationId ?? null,
		maxUses: purchase.bulkCoupon?.maxUses ?? null,
		usedCount: purchase.bulkCoupon?.usedCount ?? null,
	}
}

function createDryRunDataSource(
	plannedLinks: TeamPurchaseLinkInput[],
): TeamPurchaseFulfillmentDataSource {
	return {
		loadPurchase: (purchaseId) =>
			drizzleTeamPurchaseFulfillmentDataSource.loadPurchase(purchaseId),
		loadMemberships: (userId) =>
			drizzleTeamPurchaseFulfillmentDataSource.loadMemberships(userId),
		commitLink: async (input) => {
			plannedLinks.push(input)
			return { status: 'linked' }
		},
	}
}

async function verifyWrite(
	purchaseId: string,
	before: Readback,
	result: TeamPurchaseFulfillmentResult,
): Promise<boolean> {
	const after = await loadReadback(purchaseId)
	if (!after || !after.userId) return false
	if (before.maxUses !== after.maxUses || before.usedCount !== after.usedCount) {
		return false
	}

	const visiblePurchases = await getTeamPurchasesForMember(after.userId)
	const currentCardCount = visiblePurchases.filter(
		(purchase) => purchase.id === purchaseId,
	).length

	if (result.status === 'linked' || result.status === 'already-linked') {
		return (
			after.organizationId === result.organizationId &&
			after.organizationMembershipId === result.organizationMembershipId &&
			after.bulkCouponOrganizationId === result.organizationId &&
			currentCardCount === 1
		)
	}
	if (result.status === 'add-seat-extension') {
		const canonicalCardCount = visiblePurchases.filter(
			(purchase) => purchase.id === result.canonicalPurchaseId,
		).length
		return (
			after.organizationId === null &&
			after.organizationMembershipId === null &&
			after.bulkCouponOrganizationId === result.organizationId &&
			currentCardCount === 0 &&
			canonicalCardCount === 1
		)
	}

	return true
}

function increment(counts: Record<string, number>, key: string) {
	counts[key] = (counts[key] ?? 0) + 1
}

export async function runRepair(args: RepairArgs) {
	const startedAt = new Date().toISOString()
	const plannedLinks: TeamPurchaseLinkInput[] = []
	const dataSource = args.allowWrite
		? drizzleTeamPurchaseFulfillmentDataSource
		: createDryRunDataSource(plannedLinks)
	const statusCounts: Record<string, number> = {}
	const reasonCounts: Record<string, number> = {}
	let verifiedCount = 0
	let verificationFailures = 0
	let unresolvedCount = 0

	for (const purchaseId of args.purchaseIds) {
		const before = await loadReadback(purchaseId)
		if (!before) {
			increment(statusCounts, 'requires-review')
			increment(reasonCounts, 'link-target-missing')
			unresolvedCount += 1
			continue
		}

		const result = await reconcileTeamPurchaseFulfillment(
			purchaseId,
			dataSource,
		)
		increment(
			statusCounts,
			!args.allowWrite && result.status === 'linked'
				? 'planned-link'
				: result.status,
		)
		if ('reason' in result) increment(reasonCounts, result.reason)

		const expectedOriginalPurchaseStatus =
			result.status === 'linked' || result.status === 'already-linked'
		if (!expectedOriginalPurchaseStatus) unresolvedCount += 1

		if (args.allowWrite && expectedOriginalPurchaseStatus) {
			if (await verifyWrite(purchaseId, before, result)) {
				verifiedCount += 1
			} else {
				verificationFailures += 1
			}
		}
	}

	const acceptedOutcomeCount = args.allowWrite
		? (statusCounts.linked ?? 0) + (statusCounts['already-linked'] ?? 0)
		: (statusCounts['planned-link'] ?? 0) +
			(statusCounts['already-linked'] ?? 0)
	const success =
		unresolvedCount === 0 &&
		verificationFailures === 0 &&
		acceptedOutcomeCount === args.purchaseIds.length &&
		(!args.allowWrite || verifiedCount === args.purchaseIds.length)
	const receipt = {
		version: 1,
		success,
		task: 'team-purchase-organization-link-repair',
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		startedAt,
		completedAt: new Date().toISOString(),
		counts: {
			allowlistedPurchases: args.purchaseIds.length,
			plannedLinks: plannedLinks.length,
			verified: verifiedCount,
			verificationFailures,
			unresolved: unresolvedCount,
			statuses: statusCounts,
			reasons: reasonCounts,
		},
	}
	await writeFile(args.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
		mode: 0o600,
	})
	return receipt
}

export function getRepairExitCode(receipt: { success: boolean }): 0 | 1 {
	return receipt.success ? 0 : 1
}

async function main() {
	try {
		const args = parseRepairArgs(process.argv.slice(2))
		const receipt = await runRepair(args)
		console.log(JSON.stringify({ receiptPath: args.receiptPath, ...receipt }))
		process.exitCode = getRepairExitCode(receipt)
	} finally {
		await closeDatabasePool()
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main()
}
