import { Schema } from 'effect'

import { SessionExtractEntry, type SessionExtract } from './session-extract.js'
import type * as Views from './views.js'

/**
 * Schemas for the session extract views. The derivation itself lives in
 * `views.ts`, plain TypeScript the lesson page can bundle; the checks at the
 * bottom keep these schemas and its types in step.
 */

export const SessionView = Schema.Literals([
	'full',
	'prompts',
	'corrections',
	'skills',
	'errors',
	'chapters',
])
export type SessionView = typeof SessionView.Type

export const MomentKind = Schema.Literals([
	'prompt',
	'correction',
	'skill',
	'error',
])
export type MomentKind = typeof MomentKind.Type

const visibleFrom = Schema.Finite
const sessionId = Schema.String

/** What Matt typed, verbatim. */
export const PromptMoment = Schema.Struct({
	kind: Schema.Literal('prompt'),
	sessionId,
	visibleFrom,
	text: Schema.String,
})

/** Matt interrupting the agent, and the prompt he typed next. */
export const CorrectionMoment = Schema.Struct({
	kind: Schema.Literal('correction'),
	sessionId,
	visibleFrom,
	interrupt: Schema.String,
	followedBy: Schema.NullOr(
		Schema.Struct({ visibleFrom, text: Schema.String }),
	),
})

/** A skill the agent ran, with the arguments it was given. */
export const SkillMoment = Schema.Struct({
	kind: Schema.Literal('skill'),
	sessionId,
	visibleFrom,
	skill: Schema.String,
	via: Schema.Literals(['toolCall', 'slashCommand']),
	args: Schema.NullOr(Schema.String),
	/** The skill's page on AI Hero, when it has one. */
	skillUrl: Schema.NullOr(Schema.String),
})

/** A tool call that failed, and the next prompt or reply after it. */
export const ErrorMoment = Schema.Struct({
	kind: Schema.Literal('error'),
	sessionId,
	visibleFrom,
	tool: Schema.String,
	summary: Schema.NullOr(Schema.String),
	recovery: Schema.NullOr(
		Schema.Struct({
			kind: Schema.Literals(['userPrompt', 'assistantText']),
			visibleFrom,
			text: Schema.String,
		}),
	),
})

export const SessionMoment = Schema.Union([
	PromptMoment,
	CorrectionMoment,
	SkillMoment,
	ErrorMoment,
])
export type SessionMoment = typeof SessionMoment.Type

/**
 * One prompt and everything up to the next. Entries before the first prompt
 * form a chapter whose `prompt` is null.
 */
export const SessionChapter = Schema.Struct({
	sessionId,
	index: Schema.Finite,
	startsAt: Schema.Finite,
	/** Where the next chapter starts; null for the last of a session. */
	endsAt: Schema.NullOr(Schema.Finite),
	prompt: Schema.NullOr(Schema.String),
	entries: Schema.Array(SessionExtractEntry),
})
export type SessionChapter = typeof SessionChapter.Type

export {
	chapterOverlaps,
	extractChapters,
	extractMoments,
	momentKindForView,
	skillKey,
	type SkillLinks,
} from './views.js'

// Each schema's type and its plain twin in views.ts are the same shape; a
// drift on either side fails the build here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Agree<T extends true> = T
export type ViewsAgree = [
	Agree<Same<SessionMoment, Views.Moment>>,
	Agree<Same<SessionChapter, Views.Chapter>>,
	Agree<Same<SessionExtract, Views.Extract>>,
	Agree<Same<MomentKind, Views.MomentKind>>,
]
