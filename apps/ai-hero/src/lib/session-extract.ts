import { z } from 'zod'

/**
 * A coding-agent session shown on screen in a video, as entries stamped with
 * the video time they first appear (`visibleFrom`, seconds, about ±1 s).
 * Mirrors Matt's `session-extract.schema.json` (ai-hero-dev/session-extracts)
 * minus its `video` header: the extract lives on the video resource it is
 * timed against, so the video is implied.
 *
 * The producer omits an empty key instead of writing `null`, so every
 * nullable field also accepts a missing key and reads it as `null`.
 */
const visibleFrom = z.number().min(0)
const resultIsError = z.boolean().nullable().default(null)

const UserPromptSchema = z.object({
	kind: z.literal('userPrompt'),
	visibleFrom,
	text: z.string().min(1),
})

const AssistantTextSchema = z.object({
	kind: z.literal('assistantText'),
	visibleFrom,
	text: z.string().min(1),
})

const SkillCallViaToolCallSchema = z.object({
	kind: z.literal('skillCall'),
	via: z.literal('toolCall'),
	visibleFrom,
	skill: z.string().min(1),
	args: z.string().nullable().default(null),
	result: z.string().nullable().default(null),
	resultIsError,
	skillBody: z.string().min(1).nullable().default(null),
})

const SkillCallViaSlashCommandSchema = z.object({
	kind: z.literal('skillCall'),
	via: z.literal('slashCommand'),
	visibleFrom,
	skill: z.string().min(1),
	args: z.string().min(1).nullable().default(null),
	skillBody: z.string().min(1).nullable().default(null),
})

const ToolCallSchema = z.object({
	kind: z.literal('toolCall'),
	visibleFrom,
	tool: z.string().min(1),
	summary: z.string().max(160).nullable().default(null),
	resultIsError,
})

const InterruptSchema = z.object({
	kind: z.literal('interrupt'),
	visibleFrom,
	text: z.string(),
})

export const SessionExtractEntrySchema = z.union([
	UserPromptSchema,
	AssistantTextSchema,
	SkillCallViaToolCallSchema,
	SkillCallViaSlashCommandSchema,
	ToolCallSchema,
	InterruptSchema,
])

export const SessionExtractSchema = z.object({
	sessions: z
		.array(
			z.object({
				sessionId: z.string().min(1),
				entries: z.array(SessionExtractEntrySchema).min(1),
			}),
		)
		.min(1),
})

export type SessionExtract = z.infer<typeof SessionExtractSchema>
export type SessionExtractEntry = z.infer<typeof SessionExtractEntrySchema>

export type SessionExtractParseResult =
	| { status: 'available'; extract: SessionExtract }
	| { status: 'missing'; extract: null }
	| { status: 'invalid'; extract: null; error: z.ZodError }

/**
 * Parses a stored extract on its own, so a malformed one hides the session
 * panel and never fails the lesson or video parse around it.
 */
export function parseSessionExtract(value: unknown): SessionExtractParseResult {
	if (value === null || value === undefined) {
		return { status: 'missing', extract: null }
	}
	const parsed = SessionExtractSchema.safeParse(
		typeof value === 'string' ? safeJson(value) : value,
	)
	return parsed.success
		? { status: 'available', extract: parsed.data }
		: { status: 'invalid', extract: null, error: parsed.error }
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
}

type ToolCallEntry = z.infer<typeof ToolCallSchema>

/**
 * One rendered row. Slash-command skill calls are left out, and runs of
 * consecutive tool calls collapse into one `tools` row; `sessionStart` marks
 * a new session (a `/clear` on screen) after the first. Rows are in `visibleFrom` order, so each row's `visibleFrom` is the
 * time it first appears.
 */
export type SessionExtractRow =
	| {
			type: 'entry'
			visibleFrom: number
			entry: Exclude<SessionExtractEntry, ToolCallEntry>
	  }
	| { type: 'tools'; visibleFrom: number; entries: ToolCallEntry[] }
	| { type: 'sessionStart'; visibleFrom: number; sessionNumber: number }

export function sessionExtractRows(
	extract: SessionExtract,
): SessionExtractRow[] {
	const rows: SessionExtractRow[] = []
	extract.sessions.forEach((session, sessionIndex) => {
		if (sessionIndex > 0) {
			rows.push({
				type: 'sessionStart',
				visibleFrom: session.entries[0]!.visibleFrom,
				sessionNumber: sessionIndex + 1,
			})
		}
		for (const entry of session.entries) {
			// A slash command is already on screen as the prompt Matt typed
			// ("/code-review PR #34"); its skill call would repeat it.
			if (entry.kind === 'skillCall' && entry.via === 'slashCommand') continue
			const last = rows.at(-1)
			if (entry.kind === 'toolCall') {
				if (last?.type === 'tools') last.entries.push(entry)
				else
					rows.push({
						type: 'tools',
						visibleFrom: entry.visibleFrom,
						entries: [entry],
					})
			} else {
				rows.push({ type: 'entry', visibleFrom: entry.visibleFrom, entry })
			}
		}
	})
	// Sessions are listed in the order they first appear; keep that order but
	// guarantee the binary search below sees non-decreasing times.
	let latest = 0
	for (const row of rows) {
		latest = Math.max(latest, row.visibleFrom)
		row.visibleFrom = latest
	}
	return rows
}

/**
 * The rows on screen at `time`. A `tools` row collects a run of calls made
 * at different moments, so it lists only the calls whose own time has passed.
 */
export function rowsOnScreen(
	rows: readonly SessionExtractRow[],
	time: number,
): SessionExtractRow[] {
	return rows.slice(0, activeRowIndex(rows, time) + 1).map((row) => {
		if (row.type !== 'tools') return row
		const entries = row.entries.filter((entry) => entry.visibleFrom <= time)
		return entries.length === row.entries.length ? row : { ...row, entries }
	})
}

/**
 * Index of the row on screen at `time`: the last one whose `visibleFrom` has
 * passed, or -1 before the first. Rows are in `visibleFrom` order.
 */
export function activeRowIndex(
	rows: readonly Pick<SessionExtractRow, 'visibleFrom'>[],
	time: number,
): number {
	let low = 0
	let high = rows.length - 1
	let found = -1
	while (low <= high) {
		const mid = (low + high) >> 1
		if (rows[mid]!.visibleFrom <= time) {
			found = mid
			low = mid + 1
		} else {
			high = mid - 1
		}
	}
	return found
}

const STOP_WORDS = new Set(
	`the and for that this with you your are was were has have had not but can
	its it's into from what which who will would could should there their they
	them then than just like going gonna let's lets i'm i've we're we've okay yeah
	so say said one all any about out also more some been being does did done
	our ours here how why when where now get got really think thing things`.split(
		/\s+/,
	),
)

/** Lower-cased content words, in order: the unit both sides are matched on. */
export function contentWords(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
		(word) => word.length > 2 && !STOP_WORDS.has(word),
	)
}

/**
 * How strongly `block` matches what was just said: shared word pairs count
 * double, shared words once. Pairs carry the signal ("refund emails"); single
 * words alone match half of any reply.
 */
export function spokenMatch(
	spoken: string[],
	block: string[],
): { score: number; pairs: number } {
	const words = new Set(block)
	const blockPairs = new Set(
		block.slice(1).map((word, i) => `${block[i]} ${word}`),
	)
	let score = 0
	let pairs = 0
	const seen = new Set<string>()
	spoken.forEach((word, i) => {
		if (words.has(word) && !seen.has(word)) {
			seen.add(word)
			score += 1
		}
		const pair = i > 0 ? `${spoken[i - 1]} ${word}` : null
		if (pair && blockPairs.has(pair) && !seen.has(pair)) {
			seen.add(pair)
			score += 2
			pairs += 1
		}
	})
	return { score, pairs }
}

/**
 * The block Matt is talking about: the best match with at least two shared
 * pairs and `minScore`, clearly ahead of the runner-up. One shared phrase is
 * a coincidence ("notification system" while he riffs), so riffing returns
 * -1 and nothing is highlighted.
 */
export function spokenBlockIndex(
	spoken: string[],
	blocks: string[][],
	minScore = 5,
): number {
	let best = -1
	let bestScore = 0
	let runnerUp = 0
	blocks.forEach((block, index) => {
		const { score, pairs } = spokenMatch(spoken, block)
		if (pairs < 2) return
		if (score > bestScore) {
			runnerUp = bestScore
			bestScore = score
			best = index
		} else if (score > runnerUp) {
			runnerUp = score
		}
	})
	return bestScore >= minScore && bestScore > runnerUp + 1 ? best : -1
}
