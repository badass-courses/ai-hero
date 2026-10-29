import {
	countOf,
	formatLearningProgress,
	type LearningActivityRow,
	type LearningFunnelAggregateRow,
	type LearningProgress,
	type LearningStructure,
} from './learning-progress'

/**
 * Team purchases as learning scopes. A team is one bulk coupon: every bulk
 * purchase of the same product for the same organization shares it, so extra
 * seat purchases roll into one team.
 *
 * Team summaries and the team funnel are aggregate. Organization names are
 * not: personal organizations are named from the buyer's email, so they only
 * appear beside member rows, which are PII.
 */

export const LEARNING_TEAM_DENOMINATOR = 'team-members' as const

export type LearningTeamSummary = {
	/** The team's bulk coupon id. */
	teamId: string
	product: { id: string; name: string }
	/** Bulk purchase ids behind the team, oldest first. Opaque, not personal. */
	purchaseIds: string[]
	purchasedAt: string
	seats: {
		/** The coupon's maxUses. */
		bought: number
		/** The coupon's usedCount. */
		redeemed: number
		unredeemed: number
	}
	members: {
		/** Users holding a Valid or Restricted seat on this team now. */
		count: number
		signedIn: number
		neverSignedIn: number
		active7d: number
	}
	completion: {
		/** Required lessons in workshops open to learners at asOf. */
		openRequiredLessons: number
		/**
		 * Mean share of open required lessons each member completed, 0 to 1.
		 * Null with no members or no open lessons.
		 */
		averageShare: number | null
	}
}

export type LearningTeams = {
	asOf: string
	productId: string | null
	teams: LearningTeamSummary[]
}

export type LearningTeamProgress = {
	asOf: string
	team: LearningTeamSummary
	funnel: {
		denominator: { basis: typeof LEARNING_TEAM_DENOMINATOR; count: number }
		rows: LearningProgress['funnel']['rows']
	}
	activity: LearningProgress['activity']
}

/** PII: carries learner emails and names. Never cached. */
export type LearningTeamMember = {
	/** Present for AI Hero admins only. */
	userId?: string
	email: string | null
	name: string | null
	redeemedAt: string
	signedIn: boolean
	lastActiveAt: string | null
	lessonsCompleted: number
	workshops: { started: number; completed: number; total: number }
}

export type LearningTeamMembers = {
	asOf: string
	pii: true
	team: Pick<LearningTeamSummary, 'teamId' | 'product' | 'seats'> & {
		organization: { id: string; name: string | null } | null
	}
	members: LearningTeamMember[]
}

/** One team row as SQL returns it, before member facts. */
export type LearningTeamRow = {
	teamId: string
	productId: string
	productName: string
	purchaseIds: string | null
	purchasedAtMs: unknown
	maxUses: unknown
	usedCount: unknown
	organizationId: string | null
	organizationName: string | null
}

export type LearningTeamFactsRow = {
	teamId: string
	members: unknown
	signedIn: unknown
	active7d: unknown
	openCompleted: unknown
}

export type LearningTeamMemberRow = {
	userId: string
	email: string | null
	name: string | null
	redeemedAtMs: unknown
	signedIn: unknown
	lastActiveAt: unknown
	lessonsCompleted: unknown
	workshopsStarted: unknown
	workshopsCompleted: unknown
}

const instant = (value: unknown, label: string) => {
	const ms = Number(value)
	if (value === null || value === '' || !Number.isFinite(ms))
		throw new Error(`Learning teams returned an invalid ${label}`)
	return new Date(ms).toISOString()
}

/**
 * Progress DATETIME columns hold UTC wall-clock time. SQL formats them as
 * 'YYYY-MM-DD HH:MM:SS.mmm' so no driver or session zone shifts them.
 */
export function utcWallClock(value: unknown): string | null {
	if (value === null || value === undefined) return null
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value)
	)
		throw new Error('Learning teams returned an invalid timestamp')
	return new Date(`${value.replace(' ', 'T')}Z`).toISOString()
}

/** Open workshops at asOf: the lessons a team's completion share counts. */
export function openRequiredLessonIds(structure: LearningStructure) {
	return [
		...new Set(
			structure.nodes
				.filter(
					(node) =>
						node.kind === 'workshop' &&
						node.availability.status === 'available',
				)
				.flatMap((node) => node.lessonIds),
		),
	]
}

export function formatLearningTeamSummary(
	team: LearningTeamRow,
	facts: LearningTeamFactsRow | undefined,
	openRequiredLessons: number,
): LearningTeamSummary {
	const bought = countOf(team.maxUses, 'seat count', false)
	const redeemed = countOf(team.usedCount, 'redeemed seat count', false)
	const members = countOf(facts?.members ?? 0, 'member count')
	const signedIn = countOf(facts?.signedIn ?? 0, 'signed-in member count')
	const active7d = countOf(facts?.active7d ?? 0, 'active member count')
	const openCompleted = countOf(
		facts?.openCompleted ?? 0,
		'open lesson completion count',
	)
	if (
		signedIn > members ||
		active7d > members ||
		openCompleted > members * openRequiredLessons
	)
		throw new Error('Learning team counts do not reconcile')
	return {
		teamId: team.teamId,
		product: { id: team.productId, name: team.productName },
		purchaseIds: team.purchaseIds ? team.purchaseIds.split(',') : [],
		purchasedAt: instant(team.purchasedAtMs, 'purchase time'),
		seats: {
			bought,
			redeemed,
			unredeemed: Math.max(bought - redeemed, 0),
		},
		members: {
			count: members,
			signedIn,
			neverSignedIn: members - signedIn,
			active7d,
		},
		completion: {
			openRequiredLessons,
			averageShare:
				members > 0 && openRequiredLessons > 0
					? openCompleted / (members * openRequiredLessons)
					: null,
		},
	}
}

/**
 * The PR1 funnel with the team's members as the denominator. Every member
 * counts, signed in or not, so an unused seat holder reads as not started.
 */
export function formatLearningTeamProgress(input: {
	asOf: Date
	team: LearningTeamSummary
	structure: LearningStructure
	funnel: readonly LearningFunnelAggregateRow[]
	activity: LearningActivityRow
}): LearningTeamProgress {
	const members = input.team.members.count
	const progress = formatLearningProgress({
		asOf: input.asOf,
		product: { ...input.team.product, type: null },
		structure: input.structure,
		roster: {
			learners: members,
			purchased: 0,
			signedIn: members,
			refunded: 0,
			transferredAway: 0,
			teamSeatsUnredeemed: input.team.seats.unredeemed,
		},
		funnel: input.funnel,
		activity: input.activity,
	})
	if (progress.activity.activeLearners7d > members)
		throw new Error('Learning team activity does not reconcile')
	return {
		asOf: progress.asOf,
		team: input.team,
		funnel: {
			denominator: { basis: LEARNING_TEAM_DENOMINATOR, count: members },
			rows: progress.funnel.rows,
		},
		activity: progress.activity,
	}
}

export function formatLearningTeamMember(
	row: LearningTeamMemberRow,
	totalWorkshops: number,
	includeUserId: boolean,
): LearningTeamMember {
	const started = countOf(row.workshopsStarted, 'started workshop count')
	const completed = countOf(row.workshopsCompleted, 'completed workshop count')
	if (completed > started || started > totalWorkshops)
		throw new Error('Learning team member counts do not reconcile')
	return {
		...(includeUserId ? { userId: row.userId } : {}),
		email: row.email,
		name: row.name,
		redeemedAt: instant(row.redeemedAtMs, 'redemption time'),
		signedIn: countOf(row.signedIn, 'sign-in flag') === 1,
		lastActiveAt: utcWallClock(row.lastActiveAt),
		lessonsCompleted: countOf(row.lessonsCompleted, 'lesson completion count'),
		workshops: { started, completed, total: totalWorkshops },
	}
}
