import { db } from '../src/db/index.ts'
import {
	entitlements,
	entitlementTypes,
	organizationMemberships,
	purchases,
} from '../src/db/schema.ts'
import { getCohort } from '../src/lib/cohorts-query.ts'
import {
	createCohortEntitlementInTransaction,
	EntitlementSourceType,
} from '../src/lib/entitlements.ts'
import { and, eq, isNull, sql } from 'drizzle-orm'

const COHORT_ID = 'cohort-m0k0w'
const PRODUCT_ID = 'product-pqkk5'
const CONFIRM = 'repair-cohort-004-entitlements-2026-05-31'
const VALID_STATUSES = ['Valid', 'Restricted'] as const

type Args = {
	dryRun: boolean
	confirm?: string
	limit?: number
	offset: number
	purchaseId?: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Args = { dryRun: true, offset: 0 }
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--apply') out.dryRun = false
		else if (arg === '--dry-run') out.dryRun = true
		else if (arg === '--confirm') out.confirm = args[++i]
		else if (arg === '--limit') out.limit = Number(args[++i])
		else if (arg === '--offset') out.offset = Number(args[++i] ?? 0)
		else if (arg === '--purchase-id') out.purchaseId = args[++i]
		else if (arg === '--help') {
			console.log(
				`Usage: pnpm cohort-004:repair-entitlements [--dry-run] [--apply --confirm ${CONFIRM}] [--limit N] [--offset N] [--purchase-id ID]`,
			)
			process.exit(0)
		}
	}
	return out
}

function contentIdsFromMetadata(metadata: unknown): string[] {
	if (typeof metadata === 'string') {
		try {
			metadata = JSON.parse(metadata)
		} catch {
			return []
		}
	}
	if (!metadata || typeof metadata !== 'object') return []
	const contentIds = (metadata as { contentIds?: unknown }).contentIds
	return Array.isArray(contentIds)
		? contentIds.filter(
				(id): id is string => typeof id === 'string' && id.length > 0,
			)
		: []
}

const args = parseArgs()

if (!args.dryRun && args.confirm !== CONFIRM) {
	throw new Error(`Refusing to apply without --confirm ${CONFIRM}`)
}

const cohort = await getCohort(COHORT_ID)
if (!cohort) throw new Error(`Cohort ${COHORT_ID} not found`)

const cohortResourceIds = (cohort.resources ?? [])
	.map((entry: any) => entry.resource?.id)
	.filter(
		(id: unknown): id is string => typeof id === 'string' && id.length > 0,
	)

if (cohortResourceIds.length === 0) {
	throw new Error(`Cohort ${COHORT_ID} has no resource ids`)
}

const contentAccessEntitlementType = await db.query.entitlementTypes.findFirst({
	where: eq(entitlementTypes.name, 'cohort_content_access'),
})

if (!contentAccessEntitlementType) {
	throw new Error('cohort_content_access entitlement type not found')
}

const candidateResult: any = await db.execute(sql`
select
	p.id as purchaseId,
	p.userId as userId,
	u.email as email,
	p.productId as productId,
	p.status as status,
	p.createdAt as createdAt,
	count(e.id) as totalEntitlements,
	sum(case when et.name = 'cohort_content_access' then 1 else 0 end) as contentAccessCount
from AI_Purchase p
left join AI_User u on u.id = p.userId
left join AI_Entitlement e on e.sourceId = p.id and e.deletedAt is null
left join AI_EntitlementType et on et.id = e.entitlementType
where p.productId = ${PRODUCT_ID}
	and p.status in ('Valid', 'Restricted')
	${args.purchaseId ? sql`and p.id = ${args.purchaseId}` : sql``}
group by p.id, p.userId, u.email, p.productId, p.status, p.createdAt
having contentAccessCount < ${cohortResourceIds.length}
order by p.createdAt asc, p.id asc
`)

const purchaseRows: any[] = Array.from(
	candidateResult.rows ?? candidateResult,
).map((row: any) => ({
	id: row.purchaseId,
	userId: row.userId,
	user: { email: row.email },
	productId: row.productId,
	status: row.status,
	createdAt: row.createdAt,
	contentAccessCount: Number(row.contentAccessCount ?? 0),
	totalEntitlements: Number(row.totalEntitlements ?? 0),
}))

const windowedPurchases = purchaseRows.slice(
	args.offset,
	args.limit ? args.offset + args.limit : undefined,
)

const results = []
const plannedResourceIdsByUser = new Map<string, Set<string>>()

for (const purchase of windowedPurchases) {
	if (!purchase.userId) {
		results.push({
			purchaseId: purchase.id,
			status: 'blocked_missing_user_id',
			toAdd: [],
		})
		continue
	}

	if (
		purchase.productId !== PRODUCT_ID ||
		!VALID_STATUSES.includes(purchase.status)
	) {
		results.push({
			purchaseId: purchase.id,
			userId: purchase.userId,
			email: purchase.user?.email,
			status: 'skipped_not_valid_target_purchase',
			purchaseStatus: purchase.status,
			productId: purchase.productId,
			toAdd: [],
		})
		continue
	}

	const currentEntitlements = await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.userId, purchase.userId),
			eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
			eq(entitlements.entitlementType, contentAccessEntitlementType.id),
			isNull(entitlements.deletedAt),
		),
	})

	const currentResourceIds =
		plannedResourceIdsByUser.get(purchase.userId) ??
		new Set(
			currentEntitlements.flatMap((entitlement: any) =>
				contentIdsFromMetadata(entitlement.metadata),
			),
		)
	plannedResourceIdsByUser.set(purchase.userId, currentResourceIds)

	const toAdd = cohortResourceIds.filter((id) => !currentResourceIds.has(id))

	if (toAdd.length === 0) {
		results.push({
			purchaseId: purchase.id,
			userId: purchase.userId,
			email: purchase.user?.email,
			status: 'already_complete',
			currentContentAccessCount: currentResourceIds.size,
			toAdd,
		})
		continue
	}

	const membership = await db.query.organizationMemberships.findFirst({
		where: eq(organizationMemberships.userId, purchase.userId),
	})

	if (!membership?.organizationId) {
		results.push({
			purchaseId: purchase.id,
			userId: purchase.userId,
			email: purchase.user?.email,
			status: 'blocked_missing_organization_membership',
			currentContentAccessCount: currentResourceIds.size,
			toAdd,
		})
		continue
	}

	if (args.dryRun) {
		for (const resourceId of toAdd) currentResourceIds.add(resourceId)
		results.push({
			purchaseId: purchase.id,
			userId: purchase.userId,
			email: purchase.user?.email,
			status: 'dry_run_would_add',
			currentContentAccessCount: currentResourceIds.size,
			toAdd,
			addCount: toAdd.length,
		})
		continue
	}

	await db.transaction(async (tx) => {
		for (const resourceId of toAdd) {
			await createCohortEntitlementInTransaction(tx, {
				userId: purchase.userId,
				resourceId,
				sourceId: purchase.id,
				organizationId: membership.organizationId,
				organizationMembershipId: membership.id,
				entitlementType: contentAccessEntitlementType.id,
				sourceType: EntitlementSourceType.PURCHASE,
				metadata: { contentIds: [resourceId] },
			})
		}
	})

	for (const resourceId of toAdd) currentResourceIds.add(resourceId)

	results.push({
		purchaseId: purchase.id,
		userId: purchase.userId,
		email: purchase.user?.email,
		status: 'added',
		currentContentAccessCount: currentResourceIds.size,
		toAdd,
		addCount: toAdd.length,
	})
}

const statusCounts = results.reduce<Record<string, number>>((acc, result) => {
	acc[result.status] = (acc[result.status] ?? 0) + 1
	return acc
}, {})

console.log(
	JSON.stringify(
		{
			ok: true,
			dryRun: args.dryRun,
			cohortId: COHORT_ID,
			productId: PRODUCT_ID,
			confirmToken: CONFIRM,
			cohortResourceIds,
			purchaseCount: purchaseRows.length,
			processedCount: results.length,
			statusCounts,
			entitlementsToAdd: results.reduce(
				(sum, result: any) => sum + (result.addCount ?? 0),
				0,
			),
			results,
		},
		null,
		2,
	),
)
