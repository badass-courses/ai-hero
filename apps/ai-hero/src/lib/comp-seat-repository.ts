import { db, type DbExecutor } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	entitlementTypes,
	organization,
	organizationMemberships,
	organizationMembershipRoles,
	products,
	purchases,
	roles,
	users,
} from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { createCohortEntitlementInTransaction } from './entitlements'
import {
	compSeatError,
	compSeatRowId,
	type CompSeatContext,
	type CompSeatRepository,
	type CompSeatUserState,
	type OrganizationRow,
} from './comp-seat'

/** All reads used for the plan also run on the per-user transaction handle. */
export function compSeatReader(executor: DbExecutor) {
	return {
		async context(productId: string): Promise<CompSeatContext> {
			const product = await executor.query.products.findFirst({
				where: eq(products.id, productId),
				columns: { id: true, type: true, fields: true },
			})
			if (!product || product.type !== 'cohort')
				throw compSeatError(
					'ProductInvalid',
					'planned a grant',
					'the product is not a cohort product',
					'choose a cohort product id',
				)
			const cohorts = await executor
				.select({ id: contentResource.id })
				.from(contentResourceProduct)
				.innerJoin(
					contentResource,
					eq(contentResource.id, contentResourceProduct.resourceId),
				)
				.where(
					and(
						eq(contentResourceProduct.productId, productId),
						eq(contentResource.type, 'cohort'),
					),
				)
			if (cohorts.length !== 1)
				throw compSeatError(
					'CohortInvalid',
					'planned a grant',
					'the product must link exactly one cohort',
					'correct the product cohort relation',
				)
			const cohortId = cohorts[0]!.id
			const workshops = await executor
				.select({ id: contentResource.id })
				.from(contentResourceResource)
				.innerJoin(
					contentResource,
					eq(contentResource.id, contentResourceResource.resourceId),
				)
				.where(
					and(
						eq(contentResourceResource.resourceOfId, cohortId),
						eq(contentResource.type, 'workshop'),
						isNull(contentResourceResource.deletedAt),
					),
				)
			const contentType = await executor.query.entitlementTypes.findFirst({
				where: eq(entitlementTypes.name, 'cohort_content_access'),
				columns: { id: true },
			})
			if (!contentType)
				throw compSeatError(
					'EntitlementTypeMissing',
					'planned a grant',
					'the cohort content entitlement type is missing',
					'seed the entitlement type',
				)
			const roleValue: unknown = product.fields?.discordRoleId
			if (roleValue != null && typeof roleValue !== 'string')
				throw compSeatError(
					'DiscordRoleInvalid',
					'planned Discord access',
					'the product role is not a string',
					'correct the product Discord role',
				)
			const discordRoleId =
				typeof roleValue === 'string' && roleValue.trim() ? roleValue : null
			const discordType = discordRoleId
				? await executor.query.entitlementTypes.findFirst({
						where: eq(entitlementTypes.name, 'cohort_discord_role'),
						columns: { id: true },
					})
				: null
			return {
				productId,
				cohortId,
				workshopIds: workshops.map((row) => row.id),
				contentTypeId: contentType.id,
				discordTypeId: discordType?.id ?? null,
				discordRoleId,
			}
		},
		async userState(
			userId: string,
			productId: string,
		): Promise<CompSeatUserState> {
			// Deliberately never read names or email addresses.
			const user = await executor.query.users.findFirst({
				where: eq(users.id, userId),
				columns: { id: true },
			})
			const existing = await executor.query.purchases.findFirst({
				where: and(
					eq(purchases.userId, userId),
					eq(purchases.productId, productId),
				),
				columns: { id: true },
			})
			const personalOrg = await executor.query.organization.findFirst({
				where: eq(organization.personalOrganizationUserId, userId),
				columns: { id: true },
			})
			const organizationId = personalOrg?.id ?? compSeatRowId('org', userId)
			const member = await executor.query.organizationMemberships.findFirst({
				where: and(
					eq(organizationMemberships.userId, userId),
					eq(organizationMemberships.organizationId, organizationId),
				),
				columns: { id: true },
			})
			const membershipId = member?.id ?? compSeatRowId('membership', userId)
			const organizationRows: OrganizationRow[] = []
			// Same durable personal org + owner + learner semantics as individual
			// post-purchase. Use a neutral name instead of copying a private email.
			if (!personalOrg)
				organizationRows.push({
					table: 'organization',
					values: {
						id: organizationId,
						name: 'Personal organization',
						personalOrganizationUserId: userId,
					},
				})
			if (!member)
				organizationRows.push({
					table: 'organizationMemberships',
					values: {
						id: membershipId,
						organizationId,
						userId,
						invitedById: userId,
						personalOrganizationUserId: userId,
					},
				})
			for (const name of ['owner', 'learner']) {
				const role = await executor.query.roles.findFirst({
					where: and(
						eq(roles.organizationId, organizationId),
						eq(roles.name, name),
					),
					columns: { id: true },
				})
				const roleId = role?.id ?? compSeatRowId('role', organizationId, name)
				if (!role)
					organizationRows.push({
						table: 'roles',
						values: { id: roleId, organizationId, name },
					})
				const assignment = role
					? await executor.query.organizationMembershipRoles.findFirst({
							where: and(
								eq(
									organizationMembershipRoles.organizationMembershipId,
									membershipId,
								),
								eq(organizationMembershipRoles.roleId, roleId),
							),
							columns: { roleId: true },
						})
					: null
				if (!assignment)
					organizationRows.push({
						table: 'organizationMembershipRoles',
						values: {
							organizationId,
							organizationMembershipId: membershipId,
							roleId,
						},
					})
			}
			return {
				exists: Boolean(user),
				existingPurchaseId: existing?.id ?? null,
				organizationId,
				membershipId,
				organizationRows,
			}
		},
	}
}

export function createCompSeatRepository(): CompSeatRepository {
	return {
		...compSeatReader(db),
		async transaction(userId, operation) {
			return db.transaction(async (tx) => {
				// Serialize concurrent grants for this user. The purchase check and
				// all org, membership, purchase and entitlement writes share this tx.
				await tx
					.select({ id: users.id })
					.from(users)
					.where(eq(users.id, userId))
					.for('update')
				return operation({
					...compSeatReader(tx),
					async write(plan) {
						for (const row of plan.organizationRows) {
							switch (row.table) {
								case 'organization':
									await tx.insert(organization).values(row.values)
									break
								case 'organizationMemberships':
									await tx.insert(organizationMemberships).values(row.values)
									break
								case 'roles':
									await tx.insert(roles).values(row.values)
									break
								case 'organizationMembershipRoles':
									await tx
										.insert(organizationMembershipRoles)
										.values(row.values)
									break
							}
						}
						if (!plan.purchase)
							throw compSeatError(
								'PlanInvalid',
								'wrote a grant',
								'the purchase row is missing',
								'run a fresh dry-run',
							)
						await tx.insert(purchases).values(plan.purchase)
						for (const entitlement of plan.entitlements)
							await createCohortEntitlementInTransaction(tx, {
								...entitlement,
								resourceId: entitlement.metadata.contentIds?.[0],
							})
					},
				})
			})
		},
		async send(event) {
			// Import only after a committed grant. No commerce event is emitted.
			const { inngest } = await import('@/inngest/inngest.server')
			await inngest.send(event)
		},
	}
}
