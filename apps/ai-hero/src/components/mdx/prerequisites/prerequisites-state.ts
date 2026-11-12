/**
 * What a browser remembers about prerequisites blocks, per host lesson: the
 * learner's own collapse choice, and whether every prerequisite was done on
 * the last visit. Kept in ONE cookie so the server can render the block
 * already in its final state (no fold after hydration), and the client writes
 * it, so it is not httpOnly.
 *
 * One cookie for all lessons rather than one per lesson: every cookie rides
 * on every request to the site, so dozens of per-lesson cookies would bloat
 * all requests and crowd the browser's per-domain cookie limit. The single
 * cookie keeps the most recently touched lessons first and is capped at
 * `MAX_ENTRIES` (~1.8 KB at most with sync ids), so it stays bounded no
 * matter how many lessons a learner visits.
 *
 * Format: `<lessonId>~<flags>` entries joined by `!`, all characters that
 * `encodeURIComponent` leaves alone. Flags: `h` hidden by the learner, `s`
 * shown by the learner (at most one of those), `d` all done last time.
 */

export const PREREQUISITES_COOKIE = 'ah_prereq'
export const PREREQUISITES_COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const MAX_ENTRIES = 40

export type Remembered = { collapsed?: boolean; done?: boolean }

const ENTRY = '!'
const FIELD = '~'
const ID = /^[A-Za-z0-9_-]{1,64}$/

function parseEntries(value: string | null | undefined) {
	if (!value) return []
	return value.split(ENTRY).flatMap((entry) => {
		const [id, flags = ''] = entry.split(FIELD)
		return id && ID.test(id) ? [{ id, flags }] : []
	})
}

function toFlags(remembered: Remembered) {
	return (
		(remembered.collapsed === true
			? 'h'
			: remembered.collapsed === false
				? 's'
				: '') + (remembered.done ? 'd' : '')
	)
}

export function readRemembered(
	value: string | null | undefined,
	lessonId: string,
): Remembered {
	const flags = parseEntries(value).find((entry) => entry.id === lessonId)
		?.flags
	if (flags === undefined) return {}
	return {
		collapsed: flags.includes('h') ? true : flags.includes('s') ? false : undefined,
		done: flags.includes('d'),
	}
}

/** The cookie value with this lesson's entry first, capped in size. */
export function writeRemembered(
	value: string | null | undefined,
	lessonId: string,
	remembered: Remembered,
): string {
	if (!ID.test(lessonId)) return value ?? ''
	const rest = parseEntries(value).filter((entry) => entry.id !== lessonId)
	return [{ id: lessonId, flags: toFlags(remembered) }, ...rest]
		.slice(0, MAX_ENTRIES)
		.map((entry) => `${entry.id}${FIELD}${entry.flags}`)
		.join(ENTRY)
}
