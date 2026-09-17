import { log } from '@/server/logger'
import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'

import type { CourseSyncPlanChange } from './persistence-invariants'

/** The person who authors the source manifest for the bound course. */
export const COURSE_SYNC_AUTHOR_NAME = 'Matt'

const NARRATION_MODEL = 'anthropic/claude-sonnet-5'
const NARRATION_TIMEOUT_MS = 20_000
const MAX_LISTED_CHANGES = 40

/**
 * Distilled from the fleet unslop and Joel writing-style rules. Kept here as
 * prose rather than loaded from a skill file so the deployed function has no
 * runtime dependency on the operator's machine.
 */
const NARRATION_SYSTEM_PROMPT = `You write one short Slack notice for the team that runs an online course. It says what changed in the course after an automatic sync applied it. The person who wrote the changes is named in the input. Credit only that person.

Voice:
- Plain words. Concrete nouns. Real numbers instead of adjectives.
- One idea per sentence. Short sentences.
- Active voice only. Name the actor. Never write "was updated" or "were re-encoded".
- The author changed the course. The sync only applied it. Never write "the sync updated X" as if the tool wrote the content.
- Do not begin a sentence with a numeral.
- Lead with what changed. No preamble, no sign-off, no offer to help.
- Say what it means for the course if that is obvious from the facts. Do not speculate.

Never use: additionally, crucial, delve, enhance, comprehensive, robust, leverage, seamless, streamlined, showcase, underscore, pivotal, landscape, testament, tapestry, ensure, facilitate, utilize.
Never write "not just X, but Y". Never chain em-dashes. Never use bold labels that repeat the sentence after them. No emoji. No headings. No bullet lists.
Never pad with significance ("this marks an important step"). Never hedge with "appears to" when the facts are exact.

Rules:
- Use only the facts given. Invent nothing: no titles, counts, durations, or opinions that are not in the input.
- If a change has a title, name it in quotes.
- If many things changed, give the shape and the count rather than listing everything.
- 1 to 3 sentences. Under 60 words. Plain text only.
- Output the notice text and nothing else.`

export type CourseSyncNarrationFacts = {
	courseName: string | null
	authorName: string
	changes: CourseSyncPlanChange[]
	resourceCounts: { create: number; update: number; retain: number }
	mediaUpdated: number
	structureCounts: { sections: number; lessons: number; videos: number }
}

export function buildCourseSyncNarrationInput(
	facts: CourseSyncNarrationFacts,
): string {
	const listed = facts.changes.slice(0, MAX_LISTED_CHANGES)
	const overflow = facts.changes.length - listed.length
	const lines = listed.map((change) => {
		const flags = [
			change.moved ? 'moved' : null,
			change.detached ? 'detached' : null,
		].filter(Boolean)
		const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
		return `- ${change.action} ${change.sourceKind}: ${change.title ?? 'untitled'}${suffix}`
	})
	if (overflow > 0) lines.push(`- ...and ${overflow} more changed resources`)
	return [
		`Course: ${facts.courseName ?? 'unnamed course'}`,
		`Author of the source manifest: ${facts.authorName}`,
		`Course now has: ${facts.structureCounts.sections} sections, ${facts.structureCounts.lessons} lessons, ${facts.structureCounts.videos} videos`,
		`Resources created: ${facts.resourceCounts.create}, updated: ${facts.resourceCounts.update}, unchanged: ${facts.resourceCounts.retain}`,
		`Video assets re-encoded: ${facts.mediaUpdated}`,
		lines.length > 0 ? `Changes:\n${lines.join('\n')}` : 'Changes: none',
	].join('\n')
}

/**
 * Writes the human sentence for an applied sync. Returns null on any failure
 * so the caller can fall back to the deterministic facts line. A missing
 * narration must never cost us the notification itself.
 */
export async function narrateCourseSyncApply(
	facts: CourseSyncNarrationFacts,
): Promise<string | null> {
	try {
		const { text } = await generateText({
			model: gateway(NARRATION_MODEL),
			system: NARRATION_SYSTEM_PROMPT,
			prompt: buildCourseSyncNarrationInput(facts),
			maxOutputTokens: 300,
			temperature: 0.3,
			abortSignal: AbortSignal.timeout(NARRATION_TIMEOUT_MS),
		})
		const narration = text.trim()
		return narration.length > 0 ? narration : null
	} catch (error) {
		// The deterministic facts line still goes out. Record why the written
		// one did not, so a broken gateway is visible instead of silent.
		await log.error('course_sync.narration.failed', {
			courseName: facts.courseName,
			changeCount: facts.changes.length,
			model: NARRATION_MODEL,
			message: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
