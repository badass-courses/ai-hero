import { Schema } from 'effect'

import { SessionExtractEntry, type SessionExtract } from './session-extract.js'

/**
 * Views of Matt's session extract, derived from its entries and nothing else:
 * no summaries, no inference. Each moment is something that is on screen,
 * stamped with the video second it appears.
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

/** Skill names as the extract writes them: `/tdd`, `TDD` and `tdd` match. */
export function skillKey(skill: string): string {
	return skill.trim().replace(/^\/+/, '').toLowerCase()
}

/** Skill pages by `skillKey`. */
export type SkillLinks = ReadonlyMap<string, string>

const MOMENT_FOR_VIEW = {
	prompts: 'prompt',
	corrections: 'correction',
	skills: 'skill',
	errors: 'error',
} as const satisfies Record<string, MomentKind>

export function momentKindForView(
	view: keyof typeof MOMENT_FOR_VIEW,
): MomentKind {
	return MOMENT_FOR_VIEW[view]
}

/** Every moment of `kinds` in the extract, session by session, in order. */
export function extractMoments(
	extract: SessionExtract,
	kinds: ReadonlyArray<MomentKind>,
	skillLinks: SkillLinks = new Map(),
): SessionMoment[] {
	const wanted = new Set(kinds)
	const moments: SessionMoment[] = []
	for (const session of extract.sessions) {
		const entries = session.entries
		entries.forEach((entry, index) => {
			switch (entry.kind) {
				case 'userPrompt':
					if (wanted.has('prompt')) {
						moments.push({
							kind: 'prompt',
							sessionId: session.sessionId,
							visibleFrom: entry.visibleFrom,
							text: entry.text,
						})
					}
					return
				case 'interrupt': {
					if (!wanted.has('correction')) return
					const next = entries
						.slice(index + 1)
						.find((later) => later.kind === 'userPrompt')
					moments.push({
						kind: 'correction',
						sessionId: session.sessionId,
						visibleFrom: entry.visibleFrom,
						interrupt: entry.text,
						followedBy:
							next?.kind === 'userPrompt'
								? { visibleFrom: next.visibleFrom, text: next.text }
								: null,
					})
					return
				}
				case 'skillCall':
					if (wanted.has('skill')) {
						moments.push({
							kind: 'skill',
							sessionId: session.sessionId,
							visibleFrom: entry.visibleFrom,
							skill: entry.skill,
							via: entry.via,
							args: entry.args,
							skillUrl: skillLinks.get(skillKey(entry.skill)) ?? null,
						})
					}
					return
				case 'toolCall': {
					if (!wanted.has('error') || entry.resultIsError !== true) return
					const next = entries
						.slice(index + 1)
						.find(
							(later) =>
								later.kind === 'userPrompt' || later.kind === 'assistantText',
						)
					moments.push({
						kind: 'error',
						sessionId: session.sessionId,
						visibleFrom: entry.visibleFrom,
						tool: entry.tool,
						summary: entry.summary,
						recovery:
							next?.kind === 'userPrompt' || next?.kind === 'assistantText'
								? {
										kind: next.kind,
										visibleFrom: next.visibleFrom,
										text: next.text,
									}
								: null,
					})
					return
				}
				case 'assistantText':
					return
			}
		})
	}
	return moments
}

/** Each session split at every prompt. */
export function extractChapters(extract: SessionExtract): SessionChapter[] {
	const chapters: SessionChapter[] = []
	for (const session of extract.sessions) {
		const own: Array<{
			prompt: string | null
			entries: SessionExtractEntry[]
		}> = []
		for (const entry of session.entries) {
			const current = own.at(-1)
			if (entry.kind === 'userPrompt' || !current) {
				own.push({
					prompt: entry.kind === 'userPrompt' ? entry.text : null,
					entries: [entry],
				})
			} else {
				current.entries.push(entry)
			}
		}
		own.forEach((chapter, index) => {
			const next = own[index + 1]
			chapters.push({
				sessionId: session.sessionId,
				index,
				startsAt: chapter.entries[0]?.visibleFrom ?? 0,
				endsAt: next?.entries[0]?.visibleFrom ?? null,
				prompt: chapter.prompt,
				entries: chapter.entries,
			})
		})
	}
	return chapters
}

/** True when a chapter overlaps `[from, to]`. */
export function chapterOverlaps(
	chapter: SessionChapter,
	from: number,
	to: number,
): boolean {
	return chapter.startsAt <= to && (chapter.endsAt ?? Infinity) >= from
}
