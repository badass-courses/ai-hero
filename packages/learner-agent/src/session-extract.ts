import { Schema } from 'effect'

/**
 * Matt's on-screen coding-agent session, as typed entries stamped with the
 * video second they first appear (`visibleFrom`). Mirrors the app's zod
 * `SessionExtractSchema` (`apps/ai-hero/src/lib/session-extract.ts`); the
 * adapter parses with that one and hands the result here.
 */
const visibleFrom = Schema.Finite
const resultIsError = Schema.NullOr(Schema.Boolean)

export const UserPromptEntry = Schema.Struct({
	kind: Schema.Literal('userPrompt'),
	visibleFrom,
	text: Schema.String,
})

export const AssistantTextEntry = Schema.Struct({
	kind: Schema.Literal('assistantText'),
	visibleFrom,
	text: Schema.String,
})

export const SkillCallEntry = Schema.Struct({
	kind: Schema.Literal('skillCall'),
	via: Schema.Literals(['toolCall', 'slashCommand']),
	visibleFrom,
	skill: Schema.String,
	args: Schema.NullOr(Schema.String),
	result: Schema.optionalKey(Schema.NullOr(Schema.String)),
	resultIsError: Schema.optionalKey(resultIsError),
	skillBody: Schema.NullOr(Schema.String),
})

export const ToolCallEntry = Schema.Struct({
	kind: Schema.Literal('toolCall'),
	visibleFrom,
	tool: Schema.String,
	summary: Schema.NullOr(Schema.String),
	resultIsError,
})

export const InterruptEntry = Schema.Struct({
	kind: Schema.Literal('interrupt'),
	visibleFrom,
	text: Schema.String,
})

export const SessionExtractEntry = Schema.Union([
	UserPromptEntry,
	AssistantTextEntry,
	SkillCallEntry,
	ToolCallEntry,
	InterruptEntry,
])
export type SessionExtractEntry = typeof SessionExtractEntry.Type

export const SessionExtractSession = Schema.Struct({
	sessionId: Schema.String,
	entries: Schema.Array(SessionExtractEntry),
})

export const SessionExtract = Schema.Struct({
	sessions: Schema.Array(SessionExtractSession),
})
export type SessionExtract = typeof SessionExtract.Type

/**
 * The entries within `windowSeconds` of `atSeconds`, plus the entry on screen
 * at `atSeconds` (the last one whose `visibleFrom` has passed), so an agent
 * paused at a moment in the video sees what Matt had on screen and around it.
 */
export function windowSessionExtract(
	extract: SessionExtract,
	atSeconds: number,
	windowSeconds: number,
): {
	readonly extract: SessionExtract
	readonly onScreen: SessionExtractEntry | null
} {
	const from = atSeconds - windowSeconds
	const to = atSeconds + windowSeconds
	let onScreen: SessionExtractEntry | null = null
	for (const session of extract.sessions) {
		for (const entry of session.entries) {
			if (
				entry.visibleFrom <= atSeconds &&
				(onScreen === null || entry.visibleFrom >= onScreen.visibleFrom)
			) {
				onScreen = entry
			}
		}
	}
	const sessions = extract.sessions
		.map((session) => ({
			sessionId: session.sessionId,
			entries: session.entries.filter(
				(entry) =>
					(entry.visibleFrom >= from && entry.visibleFrom <= to) ||
					entry === onScreen,
			),
		}))
		.filter((session) => session.entries.length > 0)
	return { extract: { sessions }, onScreen }
}

export function countEntries(extract: SessionExtract): number {
	return extract.sessions.reduce(
		(total, session) => total + session.entries.length,
		0,
	)
}
