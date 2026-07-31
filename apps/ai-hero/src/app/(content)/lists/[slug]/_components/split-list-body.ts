/**
 * The redesign's course overview (`Course Page.dc.html`) is four distinct
 * blocks: an intro video beside the head, a headline + prose "why this
 * matters" split, a numbered "what you'll learn" grid, and the lesson list.
 * Only the last of those has a data source — the other three all live inside
 * one authored MDX body, because a list has exactly one body field and no
 * outcomes/video/headline fields.
 *
 * So the body is split rather than restyled. Every rule below is a guard that
 * fails closed: when a body doesn't announce the shape, nothing is hoisted and
 * the whole thing renders as prose, which is what the other lists (the skills
 * catalog, with its `##` sections and code blocks) want anyway.
 *
 * Operates on the raw markdown string, before `compileMDX` — the compiled
 * output is opaque React, and pulling three named regions back out of it is
 * not a thing you can do.
 */

export type ListBodyParts = {
	/** A leading `<Video …/>` tag, to compile into the head's right cell. */
	intro?: string
	/** A lone bolded opening line, promoted to the "why this matters" h2. */
	headline?: string
	/** Items of a declared "you'll learn:" list, for the numbered grid. */
	outcomes: string[]
	/** Everything not hoisted, still MDX, for the prose column. */
	rest: string
}

/** `<Video … />` alone in the opening block. */
const VIDEO_BLOCK = /^<Video\b[\s\S]*\/>$/

/** A single line wrapped in `**…**` and nothing else. */
const BOLD_LINE = /^\*\*(.+)\*\*$/

/**
 * The lead-in that licenses the grid: one line, ends in a colon, and promises
 * a list of outcomes. Deliberately literal — a heuristic that fires on any
 * colon would turn a prose aside into a six-cell grid.
 */
const OUTCOMES_LEAD_IN = /^[^\n]*\b(learn|cover|look at)\b[^\n:]*:\s*$/i

const MARKDOWN_LIST_ITEM = /^\s*[-*]\s+(.*)$/
const HTML_LIST_ITEM = /<li[^>]*>([\s\S]*?)<\/li>/gi

/**
 * The grid is 3×2. Fewer than three items is a sentence pretending to be a
 * grid; more than six overflows the shape the design asks for, and a body
 * that long is a table of contents, not a promise.
 */
const MIN_OUTCOMES = 3
const MAX_OUTCOMES = 6

export function splitListBody(body: string): ListBodyParts {
	const blocks = body.trim().split(/\n\s*\n/)

	let intro: string | undefined
	if (blocks[0] && VIDEO_BLOCK.test(blocks[0].trim())) {
		intro = blocks.shift()?.trim()
	}

	let headline: string | undefined
	const boldMatch = blocks[0]?.trim().match(BOLD_LINE)
	if (boldMatch?.[1] && !boldMatch[1].includes('**')) {
		headline = boldMatch[1].trim()
		blocks.shift()
	}

	let outcomes: string[] = []
	for (let i = 0; i < blocks.length - 1; i++) {
		if (!OUTCOMES_LEAD_IN.test(blocks[i]!.trim())) continue
		const items = parseListItems(blocks[i + 1]!)
		if (items.length < MIN_OUTCOMES || items.length > MAX_OUTCOMES) continue
		outcomes = items
		// Drop the lead-in with the list: on its own the colon points at
		// nothing.
		blocks.splice(i, 2)
		break
	}

	return { intro, headline, outcomes, rest: blocks.join('\n\n') }
}

/**
 * Both list dialects the CMS bodies use: plain markdown bullets, and the
 * `<ul data-checklist>` block the older tutorials were authored with.
 */
function parseListItems(block: string): string[] {
	const trimmed = block.trim()

	if (trimmed.startsWith('<ul')) {
		return [...trimmed.matchAll(HTML_LIST_ITEM)]
			.map((match) => toPlainText(match[1] ?? ''))
			.filter(Boolean)
	}

	const lines = trimmed.split('\n')
	const items: string[] = []
	for (const line of lines) {
		const match = line.match(MARKDOWN_LIST_ITEM)
		// One non-item line and it isn't a list — bail rather than render a
		// grid built from half a paragraph.
		if (!match) return []
		const text = toPlainText(match[1] ?? '')
		if (text) items.push(text)
	}
	return items
}

/**
 * Grid cells are a single styled line, so inline markup is flattened rather
 * than compiled: a cell is a label, and a link or a bold run inside one reads
 * as a second level of emphasis on something that is already the emphasis.
 */
function toPlainText(input: string): string {
	return input
		.replace(/<[^>]+>/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/(\*\*|__)(.*?)\1/g, '$2')
		.replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
		.replace(/`([^`]+)`/g, '$1')
		.trim()
}
