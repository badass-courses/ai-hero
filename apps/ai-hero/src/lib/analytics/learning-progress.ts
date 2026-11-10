import { isWorkshopAvailable } from '@/lib/cohort-navigation'

/**
 * Aggregate learner progress for one product. Nothing in this module carries
 * a user id out of MySQL: SQL groups by user inside derived tables and only
 * counts leave the database.
 */

export const LEARNING_PROGRESS_DENOMINATOR = 'signed-in-learners' as const

/** Above this many learners a progress read takes seconds; cache it longer. */
export const LEARNING_LARGE_PRODUCT_LEARNERS = 5_000

export function learningRefreshSeconds(learners: number) {
	return learners > LEARNING_LARGE_PRODUCT_LEARNERS ? 900 : 300
}

export type LearningNodeAvailability =
	| { status: 'available' }
	| { status: 'locked'; reason: 'unpublished' | 'scheduled' }

export type LearningFunnelRow = {
	id: string
	kind: 'workshop' | 'section'
	/** The workshop a section belongs to. Null for workshops. */
	workshopId: string | null
	title: string
	slug: string | null
	/** Workshop publish state. Sections inherit their workshop's. */
	state: string | null
	startsAt: string | null
	availability: LearningNodeAvailability
	requiredLessons: number
	/** Signed-in learners with any progress on this row's required lessons. */
	started: number
	/** Signed-in learners who completed every required lesson in this row. */
	completed: number
}

export type LearningProgress = {
	asOf: string
	/** How long this read is cached: 300s, or 900s above 5,000 learners. */
	refreshSeconds: number
	product: { id: string; name: string; type: string | null }
	roster: {
		/** Distinct users holding Valid or Restricted access, seat redemptions included. */
		learners: number
		bySource: { purchased: number; teamSeat: number }
		signedIn: number
		neverSignedIn: number
		removed: { refunded: number; transferredAway: number }
		teamSeatsUnredeemed: number
	}
	funnel: {
		denominator: { basis: typeof LEARNING_PROGRESS_DENOMINATOR; count: number }
		rows: LearningFunnelRow[]
	}
	activity: {
		lessonsCompleted24h: number
		lessonsCompleted7d: number
		activeLearners7d: number
		totalLessonCompletions: number
	}
}

/** One content row as the structure walk reads it. */
export type LearningResourceRow = {
	id: string
	parentId: string | null
	position: number | string
	type: string
	title: string | null
	slug: string | null
	state: string | null
	startsAt: string | null
	optional: string | boolean | null
}

const REQUIRED_LESSON_TYPES = new Set(['lesson', 'exercise'])
export const CONTAINER_TYPES = ['cohort', 'workshop', 'section'] as const

export type LearningNode = Omit<
	LearningFunnelRow,
	'started' | 'completed' | 'requiredLessons'
> & { lessonIds: string[] }

export type LearningStructure = {
	nodes: LearningNode[]
	/** Every required lesson in the product, deduped. */
	lessonIds: string[]
}

const isOptional = (value: LearningResourceRow['optional']) =>
	value === true || value === 'true'

function availabilityOf(
	workshop: LearningResourceRow,
	now: Date,
): LearningNodeAvailability {
	const available = isWorkshopAvailable(
		{ state: workshop.state ?? '', startsAt: workshop.startsAt },
		now,
	)
	if (available) return { status: 'available' }
	return {
		status: 'locked',
		reason: workshop.state === 'published' ? 'scheduled' : 'unpublished',
	}
}

/**
 * Turn the product's undeleted content rows into ordered funnel nodes.
 *
 * Required lessons follow the certificate rule in `lib/certificates.ts`:
 * lesson or exercise rows linked directly to a workshop or to one of its
 * sections, with optional lessons left out. Lesson publish state is not a
 * filter, because managed cohort lessons stay draft while their workshop is
 * published.
 */
export function buildLearningStructure(
	rows: readonly LearningResourceRow[],
	now: Date,
): LearningStructure {
	const children = new Map<string | null, LearningResourceRow[]>()
	for (const row of rows) {
		const list = children.get(row.parentId) ?? []
		list.push(row)
		children.set(row.parentId, list)
	}
	const childrenOf = (id: string | null) =>
		[...(children.get(id) ?? [])].sort(
			(a, b) =>
				Number(a.position) - Number(b.position) || a.id.localeCompare(b.id),
		)
	const lessonsOf = (id: string) =>
		childrenOf(id)
			.filter(
				(row) =>
					REQUIRED_LESSON_TYPES.has(row.type) && !isOptional(row.optional),
			)
			.map((row) => row.id)

	const nodes: LearningNode[] = []
	const seenWorkshops = new Set<string>()
	const addWorkshop = (workshop: LearningResourceRow) => {
		if (seenWorkshops.has(workshop.id)) return
		seenWorkshops.add(workshop.id)
		const availability = availabilityOf(workshop, now)
		const sections = childrenOf(workshop.id).filter(
			(row) => row.type === 'section',
		)
		const sectionNodes: LearningNode[] = sections.map((section) => ({
			id: section.id,
			kind: 'section',
			workshopId: workshop.id,
			title: section.title ?? section.id,
			slug: section.slug,
			state: workshop.state,
			startsAt: workshop.startsAt,
			availability,
			lessonIds: lessonsOf(section.id),
		}))
		nodes.push({
			id: workshop.id,
			kind: 'workshop',
			workshopId: null,
			title: workshop.title ?? workshop.id,
			slug: workshop.slug,
			state: workshop.state,
			startsAt: workshop.startsAt,
			availability,
			lessonIds: [
				...new Set([
					...lessonsOf(workshop.id),
					...sectionNodes.flatMap((section) => section.lessonIds),
				]),
			],
		})
		nodes.push(...sectionNodes)
	}

	for (const top of childrenOf(null)) {
		if (top.type === 'workshop') addWorkshop(top)
		if (top.type === 'cohort')
			for (const child of childrenOf(top.id))
				if (child.type === 'workshop') addWorkshop(child)
	}

	return {
		nodes,
		lessonIds: [
			...new Set(
				nodes
					.filter((node) => node.kind === 'workshop')
					.flatMap((node) => node.lessonIds),
			),
		],
	}
}

export type LearningRosterRow = {
	learners: unknown
	purchased: unknown
	signedIn: unknown
	refunded: unknown
	transferredAway: unknown
	teamSeatsUnredeemed: unknown
}
export type LearningFunnelAggregateRow = {
	nodeId: unknown
	started: unknown
	completed: unknown
}
export type LearningActivityRow = {
	lessonsCompleted24h: unknown
	lessonsCompleted7d: unknown
	activeLearners7d: unknown
	totalLessonCompletions: unknown
}

/** mysql2 tuple first, plus the pool's legacy .rows shape. */
export function rowsOf<T>(result: unknown, label: string): T[] {
	const rows = Array.isArray(result)
		? result[0]
		: (result as { rows?: unknown } | null)?.rows
	if (!Array.isArray(rows))
		throw new Error(`${label} query returned an unexpected driver shape`)
	return rows as T[]
}

/** Never fabricate zero from a malformed aggregate. SUM over no rows is NULL. */
export function countOf(value: unknown, label: string, nullIsZero = true) {
	if (value === null && nullIsZero) return 0
	const number =
		typeof value === 'bigint' ? Number(value) : Number(value as string | number)
	if (
		!['number', 'string', 'bigint'].includes(typeof value) ||
		value === '' ||
		!Number.isSafeInteger(number) ||
		number < 0
	)
		throw new Error(`Learning progress returned an invalid ${label}`)
	return number
}

export function formatLearningProgress(input: {
	asOf: Date
	refreshSeconds?: number
	product: LearningProgress['product']
	structure: LearningStructure
	roster: LearningRosterRow
	funnel: readonly LearningFunnelAggregateRow[]
	activity: LearningActivityRow
}): LearningProgress {
	const learners = countOf(input.roster.learners, 'learner count')
	const purchased = countOf(input.roster.purchased, 'purchased count')
	const signedIn = countOf(input.roster.signedIn, 'signed-in count')
	if (purchased > learners || signedIn > learners)
		throw new Error('Learning progress roster counts do not reconcile')
	const byNode = new Map<string, { started: number; completed: number }>()
	for (const row of input.funnel) {
		if (typeof row.nodeId !== 'string')
			throw new Error('Learning progress returned an invalid funnel row')
		const started = countOf(row.started, 'started count')
		const completed = countOf(row.completed, 'completed count')
		if (completed > started || started > signedIn)
			throw new Error('Learning progress funnel counts do not reconcile')
		byNode.set(row.nodeId, { started, completed })
	}
	return {
		asOf: input.asOf.toISOString(),
		refreshSeconds: input.refreshSeconds ?? 300,
		product: input.product,
		roster: {
			learners,
			bySource: { purchased, teamSeat: learners - purchased },
			signedIn,
			neverSignedIn: learners - signedIn,
			removed: {
				refunded: countOf(input.roster.refunded, 'refunded count'),
				transferredAway: countOf(
					input.roster.transferredAway,
					'transferred count',
				),
			},
			teamSeatsUnredeemed: countOf(
				input.roster.teamSeatsUnredeemed,
				'unredeemed seat count',
			),
		},
		funnel: {
			denominator: { basis: LEARNING_PROGRESS_DENOMINATOR, count: signedIn },
			rows: input.structure.nodes.map(({ lessonIds, ...node }) => ({
				...node,
				requiredLessons: lessonIds.length,
				started: byNode.get(node.id)?.started ?? 0,
				completed: byNode.get(node.id)?.completed ?? 0,
			})),
		},
		activity: {
			lessonsCompleted24h: countOf(
				input.activity.lessonsCompleted24h,
				'24h completion count',
			),
			lessonsCompleted7d: countOf(
				input.activity.lessonsCompleted7d,
				'7d completion count',
			),
			activeLearners7d: countOf(
				input.activity.activeLearners7d,
				'active learner count',
			),
			totalLessonCompletions: countOf(
				input.activity.totalLessonCompletions,
				'completion count',
			),
		},
	}
}
