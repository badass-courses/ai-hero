/**
 * A skill page's title frames the command so the page and the search result
 * read as sentences: "The /grill-me Skill". In a 264px navigation rail that
 * frame is three words of chrome repeated down the column — every row starts
 * with "The " and ends with " Skill", so the only part that distinguishes one
 * row from the next is buried in the middle and is the first thing to be
 * truncated away.
 *
 * This unwraps that frame for navigation surfaces ONLY. The page title, the
 * `<title>` tag, structured data, related cards and the prev/next pager all
 * keep the real title — a link that says "/grill-me" inside a sentence, or a
 * search result with no noun in it, is worse than the repetition.
 *
 * A title that is not framed this way is returned unchanged, which is what
 * makes this safe to apply to a whole list: rows like "Overview" or a skill
 * titled some other way are simply left alone.
 */
const SKILL_TITLE_FRAME = /^the\s+(.+?)\s+skill$/i

export function skillNavLabel(title: string): string {
	const inner = SKILL_TITLE_FRAME.exec(title.trim())?.[1]?.trim()
	return inner && inner.length > 0 ? inner : title
}
