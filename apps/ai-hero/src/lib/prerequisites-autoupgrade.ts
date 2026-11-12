/**
 * Upgrades an authored prerequisites list into a `<Prerequisites>` block.
 *
 * Matt writes this in lesson bodies, and changes nothing for the block:
 *
 *   ## Crash Course Prerequisites
 *
 *   - [Lesson Title](https://www.aihero.dev/workshops/<module>/<lesson>): Why it matters.
 *
 * A top-level heading whose text ends in "Prerequisites", followed directly by
 * a list where EVERY item is exactly "lesson link, `: `, reason", becomes:
 *
 *   <Prerequisites title="Crash Course Prerequisites">
 *     <Prerequisite module="…" lesson="…" href="…" label="Lesson Title">Why it matters.</Prerequisite>
 *   </Prerequisites>
 *
 * `href` and `label` carry the authored link so the server component can fall
 * back to the original heading and list when a lesson does not resolve.
 *
 * Anything else stays untouched: posts have plenty of "## Prerequisites" prose
 * sections, and one lesson has a list that is not this shape. Pure and
 * synchronous, like `callout-line-autoinsert.ts`; never throws.
 */

type Node = Record<string, any>

const LESSON_URL =
	/^(?:https?:\/\/(?:www\.)?aihero\.dev)?\/workshops\/([^/?#\s]+)\/([^/?#\s]+)\/?(?:[?#]\S*)?$/

export type PrerequisiteLink = { module: string; lesson: string }

/** The module and lesson slugs of an AI Hero lesson URL, or null. */
export function parseLessonUrl(url: unknown): PrerequisiteLink | null {
	if (typeof url !== 'string') return null
	const match = url.trim().match(LESSON_URL)
	if (!match?.[1] || !match[2]) return null
	return { module: match[1], lesson: match[2] }
}

function textOf(node: Node): string {
	if (typeof node.value === 'string') return node.value
	if (!Array.isArray(node.children)) return ''
	return node.children.map(textOf).join('')
}

const attribute = (name: string, value: string) => ({
	type: 'mdxJsxAttribute',
	name,
	value,
})

/** One list item as a `Prerequisite` element, or null when it is not one. */
function toPrerequisite(item: Node): Node | null {
	if (item?.type !== 'listItem' || item.checked != null) return null
	if (item.children?.length !== 1) return null
	const paragraph = item.children[0]
	if (paragraph?.type !== 'paragraph') return null

	const [link, separator, ...rest] = paragraph.children ?? []
	if (link?.type !== 'link') return null
	const target = parseLessonUrl(link.url)
	if (!target) return null
	const label = textOf(link).trim()
	if (!label) return null

	if (separator?.type !== 'text' || !/^:[ \t]+/.test(separator.value)) {
		return null
	}
	const leading = separator.value.replace(/^:[ \t]+/, '')
	const reason = [
		...(leading ? [{ ...separator, value: leading }] : []),
		...rest,
	]
	if (!reason.some((node) => textOf(node).trim())) return null

	return {
		type: 'mdxJsxFlowElement',
		name: 'Prerequisite',
		attributes: [
			attribute('module', target.module),
			attribute('lesson', target.lesson),
			attribute('href', link.url),
			attribute('label', label),
		],
		children: reason,
	}
}

function toPrerequisites(heading: Node, list: Node): Node | null {
	if (heading?.type !== 'heading' || list?.type !== 'list') return null
	const title = textOf(heading).trim()
	if (!/prerequisites$/i.test(title)) return null

	const items: Node[] = []
	for (const item of list.children ?? []) {
		const prerequisite = toPrerequisite(item)
		if (!prerequisite) return null
		items.push(prerequisite)
	}
	if (items.length === 0) return null

	return {
		type: 'mdxJsxFlowElement',
		name: 'Prerequisites',
		attributes: [
			attribute('title', title),
			attribute('level', String(heading.depth ?? 2)),
		],
		children: items,
	}
}

export function remarkPrerequisites() {
	return function transformPrerequisites(tree: Node) {
		try {
			const children = tree?.children
			if (!Array.isArray(children)) return
			for (let index = 0; index < children.length - 1; index++) {
				const block = toPrerequisites(children[index], children[index + 1])
				if (block) children.splice(index, 2, block)
			}
		} catch {
			// Unexpected tree shape: leave the body as authored.
		}
	}
}
