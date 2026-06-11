import { db } from '@/db'
import {
	entitlements,
	entitlementTypes,
	products,
	purchases,
} from '@/db/schema'
import { inngest } from '@/inngest/inngest.server'
import {
	DISCORD_LEGEND_ROLE_ID,
	LEGEND_ENTITLEMENT_SOURCE_ID,
} from '@/lib/discord-legend'
import { EntitlementSourceType } from '@/lib/entitlements'
import { log } from '@/server/logger'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { guid } from '@coursebuilder/adapter-drizzle/mysql'

import { GRANT_LEGEND_DISCORD_ROLE_EVENT } from '../../events/grant-legend-discord-role'
import { USER_ADDED_TO_COHORT_EVENT } from './add-discord-role-workflow'

const countActiveDistinctCohortPurchasesForUser = async (userId: string) => {
	const [result] = await db
		.select({
			count: sql<number>`count(distinct ${purchases.productId})`,
		})
		.from(purchases)
		.innerJoin(products, eq(products.id, purchases.productId))
		.where(
			and(
				eq(purchases.userId, userId),
				inArray(purchases.status, ['Valid', 'Restricted']),
				eq(products.type, 'cohort'),
			),
		)

	return Number(result?.count ?? 0)
}

const findLegendEntitlementForUser = async (
	userId: string,
	cohortDiscordRoleTypeId: string,
) => {
	return db.query.entitlements.findFirst({
		where: and(
			eq(entitlements.userId, userId),
			eq(entitlements.entitlementType, cohortDiscordRoleTypeId),
			isNull(entitlements.deletedAt),
			sql`JSON_UNQUOTE(JSON_EXTRACT(${entitlements.metadata}, '$.discordRoleId')) = ${DISCORD_LEGEND_ROLE_ID}`,
		),
	})
}

export const grantLegendDiscordRole = inngest.createFunction(
	{
		id: 'grant-legend-discord-role',
		name: 'Grant Legend Discord Role',
		idempotency: 'event.data.purchaseId',
	},
	{ event: GRANT_LEGEND_DISCORD_ROLE_EVENT },
	async ({ event, step }) => {
		const { purchaseId, userId } = event.data

		await log.info('legend_discord_role.check.started', {
			purchaseId,
			userId,
		})

		const result = await step.run(
			'grant legend discord role if eligible',
			async () => {
				const cohortDiscordRoleType = await db.query.entitlementTypes.findFirst(
					{
						where: eq(entitlementTypes.name, 'cohort_discord_role'),
					},
				)

				if (!cohortDiscordRoleType) {
					return {
						granted: false,
						reason: 'missing_entitlement_type',
					}
				}

				const existingLegendEntitlement = await findLegendEntitlementForUser(
					userId,
					cohortDiscordRoleType.id,
				)

				if (existingLegendEntitlement) {
					return {
						granted: false,
						reason: 'already_granted',
						existingEntitlementId: existingLegendEntitlement.id,
					}
				}

				const activeCohortCount =
					await countActiveDistinctCohortPurchasesForUser(userId)

				if (activeCohortCount < 3) {
					return {
						granted: false,
						activeCohortCount,
						reason: 'below_threshold',
					}
				}

				const entitlementId = `legend-discord-${guid()}`
				await db.insert(entitlements).values({
					id: entitlementId,
					entitlementType: cohortDiscordRoleType.id,
					userId,
					sourceType: EntitlementSourceType.MANUAL,
					sourceId: `${LEGEND_ENTITLEMENT_SOURCE_ID}-${purchaseId}`,
					metadata: {
						discordRoleId: DISCORD_LEGEND_ROLE_ID,
					},
				})

				return {
					granted: true,
					activeCohortCount,
					entitlementId,
				}
			},
		)

		if (result.granted) {
			await step.sendEvent('send-legend-discord-role-event', {
				name: USER_ADDED_TO_COHORT_EVENT,
				data: {
					cohortId: purchaseId,
					userId,
					discordRoleId: DISCORD_LEGEND_ROLE_ID,
				},
			})
		}

		await log.info('legend_discord_role.check.completed', {
			purchaseId,
			userId,
			result,
		})

		return result
	},
)
