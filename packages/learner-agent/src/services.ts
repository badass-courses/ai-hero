import { Context, Effect, Option } from 'effect'

import type {
	CohortOfficeHours,
	CourseStructure,
	LessonAccess,
	LessonContent,
	LessonLocator,
	OwnedCourse,
	PublicSearchHit,
	WorkshopAccess,
} from './domain.js'
import { RateLimited, Unavailable } from './errors.js'
import type { SessionExtract } from './session-extract.js'
import type { Learner, LearnerAgentPorts, SiteUrls } from './ports.js'

/**
 * The Effect-side services the handlers yield. `servicesFor` builds them
 * from the app's Promise ports for one request; a rejected port promise
 * becomes a typed `Unavailable`, never a thrown error.
 */

export class LearnerIdentity extends Context.Service<
	LearnerIdentity,
	{ readonly current: Option.Option<Learner> }
>()('@ai-hero/learner-agent/LearnerIdentity') {}

export class Entitlements extends Context.Service<
	Entitlements,
	{
		readonly ownedCourses: (
			learner: Learner,
		) => Effect.Effect<ReadonlyArray<OwnedCourse>, Unavailable>
		readonly workshopAccess: (
			learner: Learner,
			workshopId: string,
		) => Effect.Effect<WorkshopAccess, Unavailable>
		readonly lessonAccess: (
			learner: Learner,
			lesson: LessonLocator,
		) => Effect.Effect<LessonAccess, Unavailable>
	}
>()('@ai-hero/learner-agent/Entitlements') {}

export class LearnerContent extends Context.Service<
	LearnerContent,
	{
		readonly course: (
			idOrSlug: string,
		) => Effect.Effect<CourseStructure | null, Unavailable>
		readonly lesson: (
			lesson: LessonLocator,
		) => Effect.Effect<LessonContent | null, Unavailable>
		readonly officeHours: (
			cohortId: string,
		) => Effect.Effect<CohortOfficeHours | null, Unavailable>
		readonly sessionExtracts: (
			lessonIds: ReadonlyArray<string>,
		) => Effect.Effect<
			ReadonlyArray<{
				readonly lessonId: string
				readonly extract: SessionExtract
			}>,
			Unavailable
		>
		readonly skillLinks: () => Effect.Effect<
			ReadonlyArray<{ readonly skill: string; readonly url: string }>,
			Unavailable
		>
	}
>()('@ai-hero/learner-agent/LearnerContent') {}

export class LearnerProgress extends Context.Service<
	LearnerProgress,
	{
		readonly completed: (
			learner: Learner,
			resourceIds: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlySet<string>, Unavailable>
	}
>()('@ai-hero/learner-agent/LearnerProgress') {}

export class LearnerSearch extends Context.Service<
	LearnerSearch,
	{
		readonly search: (query: {
			readonly text: string
			readonly limit: number
		}) => Effect.Effect<ReadonlyArray<PublicSearchHit>, Unavailable>
	}
>()('@ai-hero/learner-agent/LearnerSearch') {}

export class LearnerAudit extends Context.Service<
	LearnerAudit,
	{
		readonly read: (event: {
			readonly userId: string
			readonly capability: string
			readonly resourceId: string
		}) => Effect.Effect<void>
	}
>()('@ai-hero/learner-agent/LearnerAudit') {}

export class LearnerRateLimit extends Context.Service<
	LearnerRateLimit,
	{
		readonly consume: (call: {
			readonly userId: string | null
			readonly capability: string
		}) => Effect.Effect<void, RateLimited>
	}
>()('@ai-hero/learner-agent/LearnerRateLimit') {}

export class LearnerSite extends Context.Service<LearnerSite, SiteUrls>()(
	'@ai-hero/learner-agent/LearnerSite',
) {}

export type LearnerServices =
	| LearnerIdentity
	| Entitlements
	| LearnerContent
	| LearnerProgress
	| LearnerSearch
	| LearnerAudit
	| LearnerRateLimit
	| LearnerSite

const unavailable = (what: string) =>
	new Unavailable({
		message: `${what} is unavailable right now. Try again shortly.`,
		next_actions: [],
	})

const fromPromise =
	(what: string, onFailure: LearnerAgentPorts['onPortFailure']) =>
	<A>(run: () => Promise<A>): Effect.Effect<A, Unavailable> =>
		Effect.tryPromise({
			try: run,
			catch: (error) => {
				onFailure?.(what, error)
				return unavailable(what)
			},
		})

/** The service context for one request, built from the app's ports. */
export function servicesFor(
	ports: LearnerAgentPorts,
): Context.Context<LearnerServices> {
	const access = fromPromise('Course access', ports.onPortFailure)
	const content = fromPromise('Course content', ports.onPortFailure)
	const progress = fromPromise('Progress', ports.onPortFailure)
	const search = fromPromise('Search', ports.onPortFailure)

	return Context.make(LearnerIdentity, {
		current: Option.fromNullishOr(ports.learner),
	}).pipe(
		Context.add(Entitlements, {
			ownedCourses: (learner) =>
				access(() => ports.entitlements.ownedCourses(learner)),
			workshopAccess: (learner, workshopId) =>
				access(() => ports.entitlements.workshopAccess(learner, workshopId)),
			lessonAccess: (learner, lesson) =>
				access(() => ports.entitlements.lessonAccess(learner, lesson)),
		}),
		Context.add(LearnerContent, {
			course: (idOrSlug) => content(() => ports.content.course(idOrSlug)),
			lesson: (lesson) => content(() => ports.content.lesson(lesson)),
			officeHours: (cohortId) =>
				content(() => ports.content.officeHours(cohortId)),
			sessionExtracts: (lessonIds) =>
				lessonIds.length === 0
					? Effect.succeed([])
					: content(() => ports.content.sessionExtracts(lessonIds)),
			skillLinks: () => content(() => ports.content.skillLinks()),
		}),
		Context.add(LearnerProgress, {
			completed: (learner, resourceIds) =>
				resourceIds.length === 0
					? Effect.succeed(new Set<string>())
					: progress(() => ports.progress.completed(learner, resourceIds)).pipe(
							Effect.map((ids) => new Set(ids)),
						),
		}),
		Context.add(LearnerSearch, {
			search: (query) => search(() => ports.search.search(query)),
		}),
		Context.add(LearnerAudit, {
			read: (event) => Effect.sync(() => ports.audit.read(event)),
		}),
		Context.add(LearnerRateLimit, {
			consume: (call) =>
				Effect.tryPromise(() => ports.rateLimit.consume(call)).pipe(
					// The adapter logs its own failures. A broken limiter must not lock
					// learners out, so a rejected check lets the call through.
					Effect.catch(() => Effect.succeed({ ok: true } as const)),
					Effect.flatMap((verdict) =>
						verdict.ok
							? Effect.void
							: Effect.fail(
									new RateLimited({
										message: `Too many requests. Try again in ${verdict.retryAfterSeconds} seconds.`,
										retryAfterSeconds: verdict.retryAfterSeconds,
										next_actions: [],
									}),
								),
					),
				),
		}),
		Context.add(LearnerSite, ports.site),
	)
}
