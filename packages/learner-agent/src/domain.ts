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

/**
 * Where the learner stands with the product on offer. `owns` carries no
 * price. `anonymous` is the default offer for a caller with no token.
 */
export const OfferState = Schema.Literals([
	'owns',
	'alumni',
	'standard',
	'anonymous',
	'not_yet_open',
	'closed',
])

/** Why the price is below the full price. */
export const OfferDiscount = Schema.Literals([
	'early_bird',
	'alumni',
	'regional',
	'quote',
	'none',
])

export const OfferProduct = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	/** The product's sales page. */
	url: Schema.String,
})

export const OfferPrice = Schema.Struct({
	currency: Schema.Literal('USD'),
	/** The full price of one seat, in cents. */
	fullCents: Schema.Int,
	/** What this learner pays now for one seat, in cents. */
	nowCents: Schema.Int,
	discount: OfferDiscount,
	/**
	 * True when the learner's own price may be lower: nobody is signed in, or
	 * part of their purchase history could not be read.
	 */
	upperBound: Schema.Boolean,
	/** True when `nowCents` already subtracts the learner's Crash Course credit. */
	includesCrashCourseCredit: Schema.Boolean,
	/** ISO date in UTC when this price ends. Null when not known. */
	priceEndsAt: Schema.NullOr(Schema.String),
	/** ISO date in UTC after which no checkout starts. Null when not known. */
	enrollmentClosesAt: Schema.NullOr(Schema.String),
	/**
	 * A lower price for the learner's country, with access restricted to that
	 * region. Null when none applies.
	 */
	regional: Schema.NullOr(
		Schema.Struct({
			nowCents: Schema.Int,
			discount: Schema.Literal('regional'),
			restriction: Schema.Literal('region'),
		}),
	),
})
export type OfferPrice = typeof OfferPrice.Type

/** Team pricing: percent off the full price per seat, by order size. */
export const OfferTeam = Schema.Struct({
	seatBands: Schema.Array(
		Schema.Struct({
			minSeats: Schema.Int,
			percentOff: Schema.Finite,
		}),
	),
	/** ISO date in UTC when these bands end. Null when they last until close. */
	bandsEndAt: Schema.NullOr(Schema.String),
})
export type OfferTeam = typeof OfferTeam.Type

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

/** The learner's current offer, decided by the app's own pricing. */
export type NextOffer = {
	readonly state: typeof OfferState.Type
	readonly product: typeof OfferProduct.Type & {
		/** The course the product sells, for `course_outline`. */
		readonly courseSlug: string | null
	}
	/** Null when the learner owns the product or it is not on sale. */
	readonly price: OfferPrice | null
	/** Present for a learner who has bought team seats before. */
	readonly team: OfferTeam | null
}

export type LessonLocator = {
	readonly lesson: string
	readonly workshop?: string | undefined
}
