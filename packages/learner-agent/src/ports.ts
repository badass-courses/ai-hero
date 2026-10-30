import type {
	CohortOfficeHours,
	CourseStructure,
	LessonAccess,
	LessonContent,
	LessonLocator,
	NextOffer,
	OwnedCourse,
	PublicSearchHit,
	WorkshopAccess,
} from './domain.js'
import type { SessionExtract } from './session-extract.js'

/**
 * What the app supplies: plain Promise functions over plain types, so the
 * app (on its own Effect version) never imports this package's Effect types.
 * Each port wraps the app's existing code; none decides access on its own
 * except `Entitlements`, which must answer with the lesson page's rules.
 */

/** Who is calling. A learner is a user id; roles never travel with it. */
export type Learner = {
	readonly userId: string
	/** How the caller authenticated, for the audit log. */
	readonly tokenKind: 'learner-token' | 'device-token'
}

export interface EntitlementsPort {
	readonly ownedCourses: (
		learner: Learner,
	) => Promise<ReadonlyArray<OwnedCourse>>
	readonly workshopAccess: (
		learner: Learner,
		workshopId: string,
	) => Promise<WorkshopAccess>
	readonly lessonAccess: (
		learner: Learner,
		lesson: LessonLocator,
	) => Promise<LessonAccess>
}

/**
 * Course content. Reads here carry no access check of their own: handlers
 * call them only after `EntitlementsPort` says yes.
 */
export interface ContentPort {
	readonly course: (idOrSlug: string) => Promise<CourseStructure | null>
	readonly lesson: (lesson: LessonLocator) => Promise<LessonContent | null>
	readonly officeHours: (cohortId: string) => Promise<CohortOfficeHours | null>
	/** The session extracts of these lessons, for those that have one. */
	readonly sessionExtracts: (lessonIds: ReadonlyArray<string>) => Promise<
		ReadonlyArray<{
			readonly lessonId: string
			readonly extract: SessionExtract
		}>
	>
	/** AI Hero's public skill pages, by the skill's name. */
	readonly skillLinks: () => Promise<
		ReadonlyArray<{ readonly skill: string; readonly url: string }>
	>
}

export interface ProgressPort {
	/** The ids among `resourceIds` this learner has completed. */
	readonly completed: (
		learner: Learner,
		resourceIds: ReadonlyArray<string>,
	) => Promise<ReadonlyArray<string>>
}

export interface SearchPort {
	/** Search over public, published content. */
	readonly search: (query: {
		readonly text: string
		readonly limit: number
	}) => Promise<ReadonlyArray<PublicSearchHit>>
}

/**
 * What AI Hero offers this learner next. The app prices it with the same
 * rules checkout uses; this package only reports it.
 */
export interface OffersPort {
	/** Whether the learner already holds the product on offer. No pricing runs. */
	readonly ownsOffer: (learner: Learner) => Promise<boolean>
	/** The current offer. `null` is an anonymous caller. */
	readonly nextOffer: (learner: Learner | null) => Promise<NextOffer>
}

export interface AuditPort {
	/** One line per paid read: user id, capability, resource id. No emails. */
	readonly read: (event: {
		readonly userId: string
		readonly capability: string
		readonly resourceId: string
	}) => void
}

export interface RateLimitPort {
	/** Consumes one call. `userId` is null for anonymous callers. */
	readonly consume: (call: {
		readonly userId: string | null
		readonly capability: string
	}) => Promise<
		| { readonly ok: true }
		| { readonly ok: false; readonly retryAfterSeconds: number }
	>
}

/** Absolute URLs the handlers put in `next_actions`. */
export type SiteUrls = {
	readonly baseUrl: string
	/** Where a learner signs in and mints an agent token. */
	readonly connectUrl: string
	/** Agent-facing instructions for using the surface as a companion. */
	readonly instructionsUrl: string
	readonly mcpUrl: string
}

/** Everything one request needs. Built per request at the app's route. */
export type LearnerAgentPorts = {
	readonly learner: Learner | null
	readonly entitlements: EntitlementsPort
	readonly content: ContentPort
	readonly progress: ProgressPort
	readonly search: SearchPort
	readonly offers: OffersPort
	readonly audit: AuditPort
	readonly rateLimit: RateLimitPort
	readonly site: SiteUrls
	/** Called with any unexpected failure, after the caller gets a 500. */
	readonly onDefect?: (capability: string, cause: string) => void
	/**
	 * Called when a port's promise rejects. The caller gets a typed
	 * `Unavailable`; this is where the app logs why.
	 */
	readonly onPortFailure?: (port: string, error: unknown) => void
}
