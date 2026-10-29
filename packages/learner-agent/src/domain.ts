import { Schema } from 'effect'

import { SessionExtract } from './session-extract.js'

/** A cohort or self-paced workshop the learner can be sold and can own. */
export const CourseType = Schema.Literals(['cohort', 'workshop'])

export const CourseRef = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	title: Schema.String,
	type: CourseType,
	url: Schema.String,
})
export type CourseRef = typeof CourseRef.Type

/** A workshop's release state, as the learner sees it. */
export const WorkshopSummary = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	title: Schema.String,
	url: Schema.String,
	/** ISO date. Null means open as soon as it is published. */
	opensAt: Schema.NullOr(Schema.String),
	isOpen: Schema.Boolean,
})
export type WorkshopSummary = typeof WorkshopSummary.Type

export const OwnedCourse = Schema.Struct({
	...CourseRef.fields,
	workshops: Schema.Array(WorkshopSummary),
	/** The earliest open date among workshops that have not opened yet. */
	nextOpensAt: Schema.NullOr(Schema.String),
})
export type OwnedCourse = typeof OwnedCourse.Type

export const OutlineLesson = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	title: Schema.String,
	type: Schema.String,
	url: Schema.String,
	completed: Schema.Boolean,
})

export const OutlineSection = Schema.Struct({
	/** Null for lessons that sit directly in the workshop. */
	title: Schema.NullOr(Schema.String),
	lessons: Schema.Array(OutlineLesson),
})

export const OutlineWorkshop = Schema.Struct({
	...WorkshopSummary.fields,
	access: Schema.Literals(['open', 'not_yet_open', 'not_entitled']),
	/** Empty unless the workshop is open to this learner. */
	sections: Schema.Array(OutlineSection),
})
export type OutlineWorkshop = typeof OutlineWorkshop.Type

export const LessonRef = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	title: Schema.String,
	type: Schema.String,
})
export type LessonRef = typeof LessonRef.Type

export const WorkshopRef = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	title: Schema.String,
})

export const LessonLinks = Schema.Struct({
	/** The lesson page, where the video plays. */
	lesson: Schema.String,
	solution: Schema.NullOr(Schema.String),
	workshop: Schema.String,
})
export type LessonLinks = typeof LessonLinks.Type

export const SolutionText = Schema.Struct({
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
})

export const OfficeHoursSession = Schema.Struct({
	course: Schema.String,
	title: Schema.String,
	startsAt: Schema.String,
	endsAt: Schema.String,
	weekday: Schema.String,
	time: Schema.String,
	timezone: Schema.Literal('UTC'),
	youtubeUrl: Schema.String,
	status: Schema.Literals(['upcoming', 'live']),
})

export const SearchHit = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	title: Schema.String,
	url: Schema.String,
	summary: Schema.String,
	/** True when the signed-in learner can read this lesson now. */
	readable: Schema.Boolean,
})
export type SearchHit = typeof SearchHit.Type

// Port data: what adapters hand the handlers. Plain types, not schemas,
// because nothing decodes them; the output schemas above are the boundary,
// and encoding through them drops any field they do not name.

export type CourseLesson = {
	readonly id: string
	readonly slug: string
	readonly title: string
	readonly type: string
	readonly url: string
}

export type CourseStructure = {
	readonly course: CourseRef
	readonly workshops: ReadonlyArray<{
		readonly id: string
		readonly slug: string
		readonly title: string
		readonly url: string
		readonly opensAt: string | null
		readonly sections: ReadonlyArray<{
			readonly title: string | null
			readonly lessons: ReadonlyArray<CourseLesson>
		}>
	}>
}

export type LessonContent = {
	readonly lesson: LessonRef
	readonly workshop: {
		readonly id: string
		readonly slug: string
		readonly title: string
	}
	readonly body: string | null
	readonly transcript: string | null
	readonly solution: {
		readonly title: string
		readonly body: string | null
	} | null
	readonly sessionExtract: SessionExtract | null
	readonly links: LessonLinks
}

export type CohortOfficeHours = {
	readonly course: string
	readonly sessions: ReadonlyArray<{
		readonly title: string
		readonly startsAt: string
		readonly endsAt: string
		readonly youtubeWatchUrl: string
	}>
}

export type PublicSearchHit = Omit<SearchHit, 'readable'>

/** Where the learner stands with one workshop, decided by the app's rules. */
export type WorkshopAccess =
	| { readonly _tag: 'Open' }
	| { readonly _tag: 'NotYetOpen'; readonly opensAt: string | null }
	| { readonly _tag: 'NotEntitled' }

export type LessonAccess =
	| { readonly _tag: 'Readable' }
	| {
			readonly _tag: 'NotYetOpen'
			readonly workshopTitle: string
			readonly opensAt: string | null
	  }
	| { readonly _tag: 'NotEntitled'; readonly workshopUrl: string | null }
	| { readonly _tag: 'NotFound' }

export type LessonLocator = {
	readonly lesson: string
	readonly workshop?: string | undefined
}
