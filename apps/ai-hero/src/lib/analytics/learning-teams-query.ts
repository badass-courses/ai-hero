import { sql, type SQL } from 'drizzle-orm'

import { rowsOf, type LearningStructure } from './learning-progress'
import {
	list,
	nodeProgressColumns,
	readLearningFunnel,
	readLearningStructure,
	signedInSql,
} from './learning-progress-query'
import {
	formatLearningTeamMember,
	formatLearningTeamProgress,
	formatLearningTeamSummary,
	openRequiredLessonIds,
	type LearningTeamFactsRow,
	type LearningTeamMemberRow,
	type LearningTeamMembers,
	type LearningTeamProgress,
	type LearningTeamRow,
	type LearningTeams,
	type LearningTeamSummary,
} from './learning-teams'

type Execute = (query: SQL) => Promise<unknown>

export class LearningTeamNotFoundError extends Error {
	constructor() {
		super('Team not found')
		this.name = 'LearningTeamNotFoundError'
	}
}

/** Which teams a read covers. Every filter lands on a Purchase index. */
export type LearningTeamFilter =
	| { kind: 'all' }
	| { kind: 'product'; productId: string }
	| { kind: 'team'; teamId: string }

/**
 * Read-only. Team rows, then per product one structure walk and one member
 * facts aggregate. Organization names are never selected here.
 */
export async function readLearningTeams(
	execute: Execute,
	productId: string | null,
	asOf: Date,
): Promise<LearningTeams> {
	const teams = rowsOf<LearningTeamRow>(
		await execute(
			learningTeamsSql(
				productId ? { kind: 'product', productId } : { kind: 'all' },
			),
		),
		'Learning teams',
	)
	const summaries = new Map<string, LearningTeamSummary>()
	for (const product of new Set(teams.map((team) => team.productId))) {
		const structure = await readLearningStructure(execute, product, asOf)
		const openLessons = openRequiredLessonIds(structure)
		const facts = rowsOf<LearningTeamFactsRow>(
			await execute(
				learningTeamFactsSql(
					{ kind: 'product', productId: product },
					structure,
					openLessons,
					asOf,
				),
			),
			'Learning team facts',
		)
		const byTeam = new Map(facts.map((row) => [row.teamId, row]))
		for (const team of teams.filter((team) => team.productId === product))
			summaries.set(
				team.teamId,
				formatLearningTeamSummary(
					team,
					byTeam.get(team.teamId),
					openLessons.length,
				),
			)
	}
	return {
		asOf: asOf.toISOString(),
		productId,
		teams: teams.map((team) => summaries.get(team.teamId)!),
	}
}

/** One team's summary plus the PR1 funnel over its members. */
export async function readLearningTeam(
	execute: Execute,
	teamRef: string,
	asOf: Date,
): Promise<LearningTeamProgress> {
	const { team, structure, summary } = await readTeamCore(
		execute,
		teamRef,
		asOf,
	)
	const progress = await readLearningFunnel(
		execute,
		structure,
		sql`SELECT seat.userId FROM (${seatsSql({ kind: 'team', teamId: team.teamId }, team.productId)}) seat`,
		asOf,
	)
	return formatLearningTeamProgress({
		asOf,
		team: summary,
		structure,
		...progress,
	})
}

/**
 * PII. Member rows for one team: AI Hero admins, or the team's own managers
 * on /team. `onlyUserId` limits the rows to one learner's own seat. Callers
 * authorize; this function only reads.
 */
export async function readLearningTeamMembers(
	execute: Execute,
	teamRef: string,
	asOf: Date,
	options: { onlyUserId?: string; includeUserIds: boolean },
): Promise<LearningTeamMembers> {
	const { team, structure, summary } = await readTeamCore(
		execute,
		teamRef,
		asOf,
	)
	const workshops = structure.nodes.filter((node) => node.kind === 'workshop')
	const rows = rowsOf<LearningTeamMemberRow>(
		await execute(learningTeamMembersSql(team, structure, options.onlyUserId)),
		'Learning team members',
	)
	return {
		asOf: asOf.toISOString(),
		pii: true,
		team: {
			teamId: summary.teamId,
			product: summary.product,
			seats: summary.seats,
			organization: team.organizationId
				? { id: team.organizationId, name: team.organizationName }
				: null,
		},
		members: rows.map((row) =>
			formatLearningTeamMember(row, workshops.length, options.includeUserIds),
		),
	}
}

async function readTeamCore(execute: Execute, teamRef: string, asOf: Date) {
	const [resolved] = rowsOf<{ teamId: string }>(
		await execute(learningTeamRefSql(teamRef)),
		'Learning team reference',
	)
	if (!resolved) throw new LearningTeamNotFoundError()
	const filter = { kind: 'team', teamId: resolved.teamId } as const
	const [team] = rowsOf<LearningTeamRow>(
		await execute(learningTeamsSql(filter, { withOrganization: true })),
		'Learning team',
	)
	if (!team) throw new LearningTeamNotFoundError()
	const structure = await readLearningStructure(execute, team.productId, asOf)
	const openLessons = openRequiredLessonIds(structure)
	const [facts] = rowsOf<LearningTeamFactsRow>(
		await execute(
			learningTeamFactsSql(
				filter,
				structure,
				openLessons,
				asOf,
				team.productId,
			),
		),
		'Learning team facts',
	)
	return {
		team,
		structure,
		summary: formatLearningTeamSummary(team, facts, openLessons.length),
	}
}

/** Teams where the user holds a Valid or Restricted redeemed seat now. */
export function learningOwnSeatTeamsSql(userId: string) {
	return sql`SELECT DISTINCT s.redeemedBulkCouponId AS teamId
		FROM AI_Purchase s
		WHERE s.userId = ${userId}
		AND BINARY s.status IN ${ACTIVE}
		AND s.redeemedBulkCouponId IS NOT NULL
		AND s.bulkCouponId IS NULL`
}

/** A team id is its bulk coupon id; a bulk purchase id resolves to it. */
export function learningTeamRefSql(teamRef: string) {
	return sql`SELECT b.bulkCouponId AS teamId FROM AI_Purchase b
		WHERE b.id = ${teamRef} AND b.bulkCouponId IS NOT NULL
		UNION ALL
		SELECT b.bulkCouponId AS teamId FROM AI_Purchase b
		WHERE b.bulkCouponId = ${teamRef}
		LIMIT 1`
}

const ACTIVE = sql.raw(`('Valid', 'Restricted')`)

function bulkFilter(filter: LearningTeamFilter) {
	if (filter.kind === 'product')
		return sql`AND b.productId = ${filter.productId}`
	if (filter.kind === 'team') return sql`AND b.bulkCouponId = ${filter.teamId}`
	return sql``
}

/**
 * Teams with at least one Valid or Restricted bulk purchase, newest first.
 * Seat counts come from the coupon, the same source /team shows.
 */
export function learningTeamsSql(
	filter: LearningTeamFilter,
	options: { withOrganization?: boolean } = {},
) {
	const organization = options.withOrganization
		? sql`, o.name AS organizationName`
		: sql`, NULL AS organizationName`
	const organizationJoin = options.withOrganization
		? sql`LEFT JOIN AI_Organization o ON o.id = t.organizationId`
		: sql``
	return sql`SELECT t.teamId AS teamId, t.productId AS productId,
		pr.name AS productName, t.purchaseIds AS purchaseIds,
		t.purchasedAtMs AS purchasedAtMs, c.maxUses AS maxUses,
		c.usedCount AS usedCount, t.organizationId AS organizationId
		${organization}
		FROM (SELECT b.bulkCouponId AS teamId, b.productId AS productId,
				GROUP_CONCAT(b.id ORDER BY b.createdAt, b.id SEPARATOR ',') AS purchaseIds,
				MIN(UNIX_TIMESTAMP(b.createdAt)) * 1000 AS purchasedAtMs,
				MAX(b.organizationId) AS organizationId
			FROM AI_Purchase b
			WHERE b.bulkCouponId IS NOT NULL
			AND BINARY b.status IN ${ACTIVE}
			${bulkFilter(filter)}
			GROUP BY b.bulkCouponId, b.productId) t
		JOIN AI_Coupon c ON c.id = t.teamId
		JOIN AI_Product pr ON pr.id = t.productId
		${organizationJoin}
		ORDER BY t.purchasedAtMs DESC, t.teamId`
}

/**
 * Team members now: one row per team and user holding a Valid or Restricted
 * redeemed seat. A product filter uses the productId index, a team filter the
 * redeemedBulkCouponId index.
 */
function seatsSql(
	filter: LearningTeamFilter,
	productId?: string,
	onlyUserId?: string,
) {
	const scope =
		filter.kind === 'team'
			? sql`AND s.redeemedBulkCouponId = ${filter.teamId}`
			: filter.kind === 'product'
				? sql`AND s.productId = ${filter.productId}`
				: sql``
	return sql`SELECT s.redeemedBulkCouponId AS teamId, s.userId AS userId,
			MIN(UNIX_TIMESTAMP(s.createdAt)) * 1000 AS redeemedAtMs
		FROM AI_Purchase s
		WHERE s.redeemedBulkCouponId IS NOT NULL
		AND s.bulkCouponId IS NULL
		AND BINARY s.status IN ${ACTIVE}
		AND s.userId IS NOT NULL
		${scope}
		${productId ? sql`AND s.productId = ${productId}` : sql``}
		${onlyUserId ? sql`AND s.userId = ${onlyUserId}` : sql``}
		GROUP BY s.redeemedBulkCouponId, s.userId`
}

/** Grouped by learner inside MySQL; only per-team counts come back. */
export function learningTeamFactsSql(
	filter: LearningTeamFilter,
	structure: LearningStructure,
	openLessonIds: readonly string[],
	asOf: Date,
	productId?: string,
) {
	const since7d = new Date(asOf.getTime() - 7 * 86_400_000)
	const seats = seatsSql(filter, productId)
	const progress = structure.lessonIds.length
		? sql`LEFT JOIN (SELECT rp.userId AS userId,
				MAX(CASE WHEN rp.createdAt >= ${since7d} OR rp.updatedAt >= ${since7d}
					OR rp.completedAt >= ${since7d} THEN 1 ELSE 0 END) AS active7d,
				${
					openLessonIds.length
						? sql`SUM(CASE WHEN rp.completedAt IS NOT NULL AND rp.resourceId IN (${list(openLessonIds)}) THEN 1 ELSE 0 END)`
						: sql`0`
				} AS openCompleted
			FROM AI_ResourceProgress rp
			WHERE rp.resourceId IN (${list(structure.lessonIds)})
			AND rp.userId IN (SELECT x.userId FROM (${seats}) x)
			GROUP BY rp.userId) g ON g.userId = seat.userId`
		: sql`LEFT JOIN (SELECT NULL AS userId, 0 AS active7d, 0 AS openCompleted) g ON FALSE`
	return sql`SELECT m.teamId AS teamId, COUNT(*) AS members,
		SUM(m.signedIn) AS signedIn, SUM(m.active7d) AS active7d,
		SUM(m.openCompleted) AS openCompleted
		FROM (SELECT seat.teamId AS teamId,
				${signedInSql('u', 'seat.userId')} AS signedIn,
				COALESCE(g.active7d, 0) AS active7d,
				COALESCE(g.openCompleted, 0) AS openCompleted
			FROM (${seats}) seat
			LEFT JOIN AI_User u ON u.id = seat.userId
			${progress}) m
		GROUP BY m.teamId`
}

/**
 * PII rows. Workshop counts read the per-node t<i>/d<i> columns for workshop
 * nodes only. Progress DATETIMEs are formatted, so no zone shifts them.
 */
export function learningTeamMembersSql(
	team: Pick<LearningTeamRow, 'teamId' | 'productId'>,
	structure: LearningStructure,
	onlyUserId?: string,
) {
	const filter = { kind: 'team', teamId: team.teamId } as const
	const seats = seatsSql(filter, team.productId, onlyUserId)
	const workshops = structure.nodes.flatMap((node, index) =>
		node.kind === 'workshop' && node.lessonIds.length
			? [{ index, lessons: node.lessonIds.length }]
			: [],
	)
	const started = workshops.length
		? sql.join(
				workshops.map(({ index }) =>
					sql.raw(`CASE WHEN COALESCE(g.t${index}, 0) > 0 THEN 1 ELSE 0 END`),
				),
				sql` + `,
			)
		: sql`0`
	const completed = workshops.length
		? sql.join(
				workshops.map(
					({ index, lessons }) =>
						sql`CASE WHEN COALESCE(${sql.raw(`g.d${index}`)}, 0) >= ${lessons} THEN 1 ELSE 0 END`,
				),
				sql` + `,
			)
		: sql`0`
	const progress = structure.lessonIds.length
		? sql`LEFT JOIN (SELECT rp.userId AS userId,
				DATE_FORMAT(MAX(GREATEST(rp.createdAt,
					COALESCE(rp.updatedAt, rp.createdAt),
					COALESCE(rp.completedAt, rp.createdAt))), '%Y-%m-%d %H:%i:%s') AS lastActiveAt,
				SUM(CASE WHEN rp.completedAt IS NOT NULL THEN 1 ELSE 0 END) AS completions
				${sql.join(nodeProgressColumns(structure))}
			FROM AI_ResourceProgress rp
			WHERE rp.resourceId IN (${list(structure.lessonIds)})
			AND rp.userId IN (SELECT x.userId FROM (${seats}) x)
			GROUP BY rp.userId) g ON g.userId = seat.userId`
		: sql`LEFT JOIN (SELECT NULL AS userId, NULL AS lastActiveAt, 0 AS completions) g ON FALSE`
	return sql`SELECT seat.userId AS userId, u.email AS email, u.name AS name,
		seat.redeemedAtMs AS redeemedAtMs,
		${signedInSql('u', 'seat.userId')} AS signedIn,
		g.lastActiveAt AS lastActiveAt,
		COALESCE(g.completions, 0) AS lessonsCompleted,
		${started} AS workshopsStarted,
		${completed} AS workshopsCompleted
		FROM (${seats}) seat
		LEFT JOIN AI_User u ON u.id = seat.userId
		${progress}
		ORDER BY seat.redeemedAtMs, seat.userId`
}
