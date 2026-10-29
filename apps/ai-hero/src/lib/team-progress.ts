import type { LearningTeamMembers } from '@/lib/analytics/learning-teams'
import { log } from '@/server/logger'

import type { Purchase } from '@coursebuilder/core/schemas'

/**
 * Team progress on /team.
 *
 * - `team`: every member row for a team the viewer manages: an organization
 *   owner or billing admin (`getTeamPurchasesForMember`), or the buyer of a
 *   pool that has no organization, who already sees its claimed seats.
 * - `self`: the viewer's own row on a team where they hold a seat but do not
 *   manage it.
 *
 * Nobody else gets anything. Every read is logged with the viewer and the
 * team ids, never member emails.
 */
export type TeamProgressBlock = {
	teamId: string
	scope: 'team' | 'self'
	data: LearningTeamMembers
}

export type TeamProgressDeps = {
	listOwnSeatTeamIds(userId: string): Promise<string[]>
	readMembers(
		teamId: string,
		options: { onlyUserId?: string; includeUserIds: boolean },
	): Promise<LearningTeamMembers>
}

const ACTIVE = new Set(['Valid', 'Restricted'])

/** Team ids the viewer may see in full. Bulk coupon ids, deduped. */
export function managedTeamIds(
	managedPurchases: readonly Pick<Purchase, 'bulkCouponId' | 'status'>[],
) {
	return [
		...new Set(
			managedPurchases.flatMap((purchase) =>
				purchase.bulkCouponId && ACTIVE.has(purchase.status)
					? [purchase.bulkCouponId]
					: [],
			),
		),
	]
}

export async function loadTeamProgressForViewer({
	viewerId,
	managedPurchases,
	deps,
}: {
	viewerId: string
	managedPurchases: readonly Pick<Purchase, 'bulkCouponId' | 'status'>[]
	deps?: TeamProgressDeps
}): Promise<TeamProgressBlock[]> {
	const source = deps ?? (await defaultDeps())
	const managed = managedTeamIds(managedPurchases)
	const ownSeats = await source
		.listOwnSeatTeamIds(viewerId)
		.catch(async (error) => {
			await log.error('team.progress.own-seats-failed', { viewerId, error })
			return [] as string[]
		})
	const requests = [
		...managed.map((teamId) => ({ teamId, scope: 'team' as const })),
		...ownSeats
			.filter((teamId) => !managed.includes(teamId))
			.map((teamId) => ({ teamId, scope: 'self' as const })),
	]
	if (requests.length === 0) return []

	// A failed team leaves the rest of the page; it never blocks seat actions.
	const blocks = await Promise.all(
		requests.map(async ({ teamId, scope }) => {
			try {
				const data = await source.readMembers(
					teamId,
					scope === 'self'
						? { onlyUserId: viewerId, includeUserIds: true }
						: { includeUserIds: false },
				)
				// A seat holder sees their own row only: the organization name can
				// carry the buyer's email, and seat counts are the managers' business.
				return scope === 'self'
					? {
							teamId,
							scope,
							data: {
								...data,
								team: {
									...data.team,
									organization: null,
									seats: { bought: 0, redeemed: 0, unredeemed: 0 },
								},
								// The query is scoped too; this keeps another row out.
								members: data.members
									.filter((member) => member.userId === viewerId)
									.map(({ userId: _userId, ...member }) => member),
							},
						}
					: { teamId, scope, data }
			} catch (error) {
				await log.error('team.progress.read-failed', {
					viewerId,
					teamId,
					scope,
					error,
				})
				return null
			}
		}),
	)
	const loaded = blocks.filter((block) => block !== null)
	await log.info('team.progress.read', {
		viewerId,
		teams: loaded.map(({ teamId, scope, data }) => ({
			teamId,
			scope,
			memberCount: data.members.length,
		})),
	})
	return loaded
}

async function defaultDeps(): Promise<TeamProgressDeps> {
	const { listOwnSeatTeamIds, readLearningTeamMembersUncached } =
		await import('@/lib/analytics/providers/database')
	return {
		listOwnSeatTeamIds,
		readMembers: readLearningTeamMembersUncached,
	}
}
