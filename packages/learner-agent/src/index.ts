/**
 * The public face of the package: plain functions over plain types. The
 * app imports nothing Effect-typed from here, so its Effect version and
 * this package's never meet.
 */
export {
	learnerCatalog,
	learnerOpenApi,
	learnerTools,
	makeLearnerAgent,
	SERVER_INFO,
	type LearnerAgent,
} from './agent.js'
export type {
	CohortOfficeHours,
	CourseLesson,
	CourseRef,
	CourseStructure,
	LessonAccess,
	LessonContent,
	LessonLinks,
	LessonLocator,
	LessonRef,
	OwnedCourse,
	PublicSearchHit,
	WorkshopAccess,
	WorkshopSummary,
} from './domain.js'
export type {
	AuditPort,
	ContentPort,
	EntitlementsPort,
	Learner,
	LearnerAgentPorts,
	ProgressPort,
	RateLimitPort,
	SearchPort,
	SiteUrls,
} from './ports.js'
export type { InvokeResult } from './projections/invoke.js'
export type { ToolCatalog, ToolCatalogEntry } from './projections/catalog.js'
export { COMPANION_RULES } from './prompts.js'
export type { SessionExtract, SessionExtractEntry } from './session-extract.js'
export {
	extractChapters,
	extractMoments,
	skillKey,
	type MomentKind,
	type SessionChapter,
	type SessionMoment,
	type SessionView,
} from './session-views.js'
