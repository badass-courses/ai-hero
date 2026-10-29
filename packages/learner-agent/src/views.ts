/**
 * Views of Matt's session extract, derived from its entries and nothing else:
 * no summaries, no inference. Each moment is something that is on screen,
 * stamped with the video second it appears.
 *
 * Plain TypeScript with no imports, so the lesson page's client bundle can
 * use the same derivation as the agent tools (`@ai-hero/learner-agent/views`)
 * without pulling in Effect. `session-views.ts` holds the matching schemas
 * and checks they agree with these types.
 */

export type ExtractEntry =
	| {
			readonly kind: 'userPrompt'
			readonly visibleFrom: number
			readonly text: string
	  }
	| {
			readonly kind: 'assistantText'
			readonly visibleFrom: number
			readonly text: string
	  }
	| {
			readonly kind: 'skillCall'
			readonly via: 'toolCall' | 'slashCommand'
			readonly visibleFrom: number
			readonly skill: string
			readonly args: string | null
			readonly result?: string | null
			readonly resultIsError?: boolean | null
			readonly skillBody: string | null
	  }
	| {
			readonly kind: 'toolCall'
			readonly visibleFrom: number
			readonly tool: string
			readonly summary: string | null
			readonly resultIsError: boolean | null
	  }
	| {
			readonly kind: 'interrupt'
			readonly visibleFrom: number
			readonly text: string
	  }

export type Extract = {
	readonly sessions: ReadonlyArray<{
		readonly sessionId: string
		readonly entries: ReadonlyArray<ExtractEntry>
	}>
}

export type MomentKind = 'prompt' | 'correction' | 'skill' | 'error'

/** What Matt typed, verbatim. */
export type PromptMoment = {
	readonly kind: 'prompt'
	readonly sessionId: string
	readonly visibleFrom: number
	readonly text: string
}

/** Matt interrupting the agent, and the prompt he typed next. */
export type CorrectionMoment = {
	readonly kind: 'correction'
	readonly sessionId: string
	readonly visibleFrom: number
	readonly interrupt: string
	readonly followedBy: {
		readonly visibleFrom: number
		readonly text: string
	} | null
}

/** A skill the agent ran, with the arguments it was given. */
export type SkillMoment = {
	readonly kind: 'skill'
	readonly sessionId: string
	readonly visibleFrom: number
	readonly skill: string
	readonly via: 'toolCall' | 'slashCommand'
	readonly args: string | null
	/** The skill's page on AI Hero, when it has one. */
	readonly skillUrl: string | null
}

/** A tool call that failed, and the next prompt or reply after it. */
export type ErrorMoment = {
	readonly kind: 'error'
	readonly sessionId: string
	readonly visibleFrom: number
	readonly tool: string
	readonly summary: string | null
	readonly recovery: {
		readonly kind: 'userPrompt' | 'assistantText'
		readonly visibleFrom: number
		readonly text: string
	} | null
}

export type Moment = PromptMoment | CorrectionMoment | SkillMoment | ErrorMoment

/**
 * One prompt and everything up to the next. Entries before the first prompt
 * form a chapter whose `prompt` is null.
 */
export type Chapter = {
	readonly sessionId: string
	readonly index: number
	readonly startsAt: number
	/** Where the next chapter starts; null for the last of a session. */
	readonly endsAt: number | null
	readonly prompt: string | null
	readonly entries: ReadonlyArray<ExtractEntry>
}

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
	extract: Extract,
	kinds: ReadonlyArray<MomentKind>,
	skillLinks: SkillLinks = new Map(),
): Moment[] {
	const wanted = new Set(kinds)
	const moments: Moment[] = []
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
export function extractChapters(extract: Extract): Chapter[] {
	const chapters: Chapter[] = []
	for (const session of extract.sessions) {
		const own: Array<{ prompt: string | null; entries: ExtractEntry[] }> = []
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
	chapter: Pick<Chapter, 'startsAt' | 'endsAt'>,
	from: number,
	to: number,
): boolean {
	return chapter.startsAt <= to && (chapter.endsAt ?? Infinity) >= from
}
