import { sql, type SQL } from 'drizzle-orm'

import {
	buildLearningStructure,
	CONTAINER_TYPES,
	countOf,
	formatLearningProgress,
	rowsOf,
	type LearningActivityRow,
	type LearningFunnelAggregateRow,
	type LearningProgress,
	type LearningResourceRow,
	type LearningRosterRow,
	type LearningStructure,
} from './learning-progress'

export class LearningProductNotFoundError extends Error {
	constructor() {
		super('Product not found')
		this.name = 'LearningProductNotFoundError'
	}
}

/** cohort -> workshop -> section -> lesson is the deepest product tree. */
const MAX_STRUCTURE_DEPTH = 4

/**
 * Read-only. Four small indexed structure reads, one roster aggregate and
 * one progress aggregate; no user-level row leaves MySQL.
 */
export async function readLearningProgress(
	execute: (query: SQL) => Promise<unknown>,
	productId: string,
	asOf: Date,
): Promise<LearningProgress> {
	const [product] = rowsOf<{ id: string; name: string; type: string | null }>(
		await execute(learningProductSql(productId)),
		'Learning product',
	)
	if (!product) throw new LearningProductNotFoundError()

	const rows = rowsOf<LearningResourceRow>(
		await execute(learningRootsSql(productId)),
		'Learning structure',
	)
	const seen = new Set(rows.map((row) => row.id))
	let frontier = rows.filter((row) => isLearningContainer(row.type))
	for (let depth = 0; depth < MAX_STRUCTURE_DEPTH && frontier.length; depth++) {
		const children = rowsOf<LearningResourceRow>(
			await execute(learningChildrenSql(frontier.map((row) => row.id))),
			'Learning structure',
		).filter((row) => !seen.has(row.id) || isLearningLeaf(row))
		for (const row of children) seen.add(row.id)
		rows.push(...children)
		frontier = children.filter((row) => isLearningContainer(row.type))
	}

	const structure = buildLearningStructure(rows, asOf)
	const [roster] = rowsOf<LearningRosterRow>(
		await execute(learningRosterSql(productId)),
		'Learning roster',
	)
	if (!roster) throw new Error('Learning roster query returned no row')
	const progress = structure.lessonIds.length
		? splitLearningProgressRow(
				rowsOf<Record<string, unknown>>(
					await execute(learningProgressSql(productId, structure, asOf)),
					'Learning progress',
				)[0],
				structure,
			)
		: {
				activity: {
					lessonsCompleted24h: 0,
					lessonsCompleted7d: 0,
					activeLearners7d: 0,
					totalLessonCompletions: 0,
				},
				funnel: [],
			}
	return formatLearningProgress({
		asOf,
		product: { id: product.id, name: product.name, type: product.type ?? null },
		structure,
		roster,
		...progress,
	})
}

/** A lesson may sit in two sections; containers are walked only once. */
const isLearningLeaf = (row: LearningResourceRow) =>
	!isLearningContainer(row.type)

/** Missing JSON keys and JSON null both read as SQL NULL. */
const field = (path: string) =>
	sql.raw(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(cr.fields, '$.${path}')), 'null')`)

const resourceColumns = sql`cr.type AS type,
	${field('title')} AS title,
	${field('slug')} AS slug,
	${field('state')} AS state,
	${field('startsAt')} AS startsAt,
	${field('optional')} AS optional`

/** Products that carry a cohort or workshop, newest first. Small table. */
export function learningProductsSql() {
	return sql`SELECT p.id AS id, p.name AS name, p.type AS type
		FROM AI_Product p
		WHERE EXISTS (SELECT 1 FROM AI_ContentResourceProduct crp
			JOIN AI_ContentResource cr ON cr.id = crp.resourceId
			WHERE crp.productId = p.id
			AND crp.deletedAt IS NULL AND cr.deletedAt IS NULL
			AND cr.type IN ('cohort', 'workshop'))
		ORDER BY p.createdAt DESC, p.id`
}

export function learningProductSql(productId: string) {
	return sql`SELECT p.id AS id, p.name AS name, p.type AS type
		FROM AI_Product p WHERE p.id = ${productId}`
}

export function learningRootsSql(productId: string) {
	return sql`SELECT crp.resourceId AS id, NULL AS parentId, crp.position AS position,
		${resourceColumns}
		FROM AI_ContentResourceProduct crp
		JOIN AI_ContentResource cr ON cr.id = crp.resourceId
		WHERE crp.productId = ${productId}
		AND crp.deletedAt IS NULL AND cr.deletedAt IS NULL`
}

/** One level of undeleted children under the given container ids. */
export function learningChildrenSql(parentIds: readonly string[]) {
	return sql`SELECT crr.resourceId AS id, crr.resourceOfId AS parentId, crr.position AS position,
		${resourceColumns}
		FROM AI_ContentResourceResource crr
		JOIN AI_ContentResource cr ON cr.id = crr.resourceId
		WHERE crr.resourceOfId IN (${list(parentIds)})
		AND crr.deletedAt IS NULL AND cr.deletedAt IS NULL`
}

/** Containers whose children the walk still needs. Lessons are leaves. */
export const isLearningContainer = (type: string) =>
	(CONTAINER_TYPES as readonly string[]).includes(type)

const list = (values: readonly string[]) =>
	sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)

/**
 * Users who hold access to the product now. Mirrors the purchase rule in
 * `ability/index.ts`: Valid or Restricted, never a team buyer's bulk
 * purchase. A redeemed team seat is its own purchase row, so it counts.
 */
function learnerPurchases(productId: string) {
	return sql`SELECT p.userId AS userId,
			MAX(CASE WHEN p.redeemedBulkCouponId IS NULL THEN 1 ELSE 0 END) AS purchased
		FROM AI_Purchase p
		WHERE p.productId = ${productId}
		AND BINARY p.status IN ('Valid', 'Restricted')
		AND p.bulkCouponId IS NULL
		AND p.userId IS NOT NULL
		GROUP BY p.userId`
}

function learnerIds(productId: string) {
	return sql`SELECT lp.userId FROM (${learnerPurchases(productId)}) lp`
}

/**
 * Sign-in evidence, any of: a verified email (set by magic-link sign-in), a
 * linked OAuth account, a current database session, or any lesson progress.
 * Expired sessions are deleted, so a legacy sign-in with none of these is
 * counted as never signed in.
 */
export function learningRosterSql(productId: string) {
	return sql`SELECT COUNT(*) AS learners,
		COALESCE(SUM(l.purchased), 0) AS purchased,
		COALESCE(SUM(CASE WHEN u.emailVerified IS NOT NULL
			OR EXISTS (SELECT 1 FROM AI_Account a WHERE a.userId = l.userId)
			OR EXISTS (SELECT 1 FROM AI_Session s WHERE s.userId = l.userId)
			OR EXISTS (SELECT 1 FROM AI_ResourceProgress rp WHERE rp.userId = l.userId)
			THEN 1 ELSE 0 END), 0) AS signedIn,
		(SELECT COUNT(DISTINCT r.userId) FROM AI_Purchase r
			WHERE r.productId = ${productId}
			AND BINARY r.status = 'Refunded'
			AND r.bulkCouponId IS NULL
			AND r.userId IS NOT NULL
			AND r.userId NOT IN (${learnerIds(productId)})) AS refunded,
		(SELECT COUNT(DISTINCT t.sourceUserId) FROM AI_PurchaseUserTransfer t
			JOIN AI_Purchase tp ON tp.id = t.purchaseId
			WHERE tp.productId = ${productId}
			AND t.transferState = 'COMPLETED'
			AND t.sourceUserId NOT IN (${learnerIds(productId)})) AS transferredAway,
		(SELECT COALESCE(SUM(GREATEST(c.maxUses - c.usedCount, 0)), 0)
			FROM (SELECT DISTINCT b.bulkCouponId FROM AI_Purchase b
				WHERE b.productId = ${productId}
				AND BINARY b.status IN ('Valid', 'Restricted')
				AND b.bulkCouponId IS NOT NULL) bc
			JOIN AI_Coupon c ON c.id = bc.bulkCouponId) AS teamSeatsUnredeemed
		FROM (${learnerPurchases(productId)}) l
		LEFT JOIN AI_User u ON u.id = l.userId`
}

/**
 * One pass over the product's progress rows. The inner query groups by
 * learner and never leaves MySQL; the outer query returns a single row of
 * counts, two columns per funnel node (s<i> started, c<i> completed).
 */
export function learningProgressSql(
	productId: string,
	structure: LearningStructure,
	asOf: Date,
): SQL {
	const since24h = new Date(asOf.getTime() - 86_400_000)
	const since7d = new Date(asOf.getTime() - 7 * 86_400_000)
	const inner: SQL[] = []
	const outer: SQL[] = []
	structure.nodes.forEach((node, index) => {
		if (node.lessonIds.length === 0) return
		const lessons = list(node.lessonIds)
		inner.push(
			sql.raw(`, SUM(CASE WHEN rp.resourceId IN (`),
			lessons,
			sql.raw(`) THEN 1 ELSE 0 END) AS t${index}`),
			sql.raw(
				`, SUM(CASE WHEN rp.completedAt IS NOT NULL AND rp.resourceId IN (`,
			),
			lessons,
			sql.raw(`) THEN 1 ELSE 0 END) AS d${index}`),
		)
		outer.push(
			sql.raw(
				`, SUM(CASE WHEN u.t${index} > 0 THEN 1 ELSE 0 END) AS s${index}`,
			),
			sql.raw(`, SUM(CASE WHEN u.d${index} >= `),
			sql`${node.lessonIds.length}`,
			sql.raw(` THEN 1 ELSE 0 END) AS c${index}`),
		)
	})
	return sql`SELECT COALESCE(SUM(u.c24), 0) AS lessonsCompleted24h,
		COALESCE(SUM(u.c7), 0) AS lessonsCompleted7d,
		COALESCE(SUM(u.active7d), 0) AS activeLearners7d,
		COALESCE(SUM(u.completions), 0) AS totalLessonCompletions
		${sql.join(outer)}
		FROM (SELECT rp.userId,
			SUM(CASE WHEN rp.completedAt >= ${since24h} THEN 1 ELSE 0 END) AS c24,
			SUM(CASE WHEN rp.completedAt >= ${since7d} THEN 1 ELSE 0 END) AS c7,
			MAX(CASE WHEN rp.createdAt >= ${since7d} OR rp.updatedAt >= ${since7d}
				OR rp.completedAt >= ${since7d} THEN 1 ELSE 0 END) AS active7d,
			SUM(CASE WHEN rp.completedAt IS NOT NULL THEN 1 ELSE 0 END) AS completions
			${sql.join(inner)}
			FROM AI_ResourceProgress rp
			WHERE rp.resourceId IN (${list(structure.lessonIds)})
			AND rp.userId IN (${learnerIds(productId)})
			GROUP BY rp.userId) u`
}

/** Split the single wide progress row into activity and per-node counts. */
export function splitLearningProgressRow(
	row: Record<string, unknown> | undefined,
	structure: LearningStructure,
): { activity: LearningActivityRow; funnel: LearningFunnelAggregateRow[] } {
	if (!row) throw new Error('Learning progress query returned no row')
	const funnel: LearningFunnelAggregateRow[] = []
	structure.nodes.forEach((node, index) => {
		if (node.lessonIds.length === 0) return
		funnel.push({
			nodeId: node.id,
			started: countOf(row[`s${index}`], 'started count'),
			completed: countOf(row[`c${index}`], 'completed count'),
		})
	})
	return {
		activity: {
			lessonsCompleted24h: row.lessonsCompleted24h,
			lessonsCompleted7d: row.lessonsCompleted7d,
			activeLearners7d: row.activeLearners7d,
			totalLessonCompletions: row.totalLessonCompletions,
		},
		funnel,
	}
}
