import type { PageAutoLink } from '@/lib/dictionary-autolink'
import { SANDCASTLE_DOCS_PATH } from '@/lib/sandcastle-docs'

/**
 * Lessons and articles name Sandcastle by linking its GitHub repo:
 * "So I built [Sandcastle](https://github.com/mattpocock/sandcastle)". Now the
 * docs live on this site, so a link whose text is the tool's name opens them
 * there. A link that says something else ("the Sandcastle repository", an
 * issue) means GitHub and keeps pointing at it.
 *
 * Runs before the auto-linker, which then sees the page already linked and
 * does not link the next mention again.
 */
const REPO_URL =
	/^https?:\/\/(www\.)?github\.com\/mattpocock\/sandcastle\/?(#readme)?$/i

/** The first plain "Sandcastle" in a body links to the docs, like a term. */
export const SANDCASTLE_PAGE_AUTOLINK: PageAutoLink = {
	phrase: 'Sandcastle',
	url: SANDCASTLE_DOCS_PATH,
}

type MdNode = {
	type: string
	url?: string
	value?: string
	children?: MdNode[]
}

function plainText(node: MdNode): string {
	if (node.value !== undefined) return node.value
	return (node.children ?? []).map(plainText).join('')
}

function rewrite(node: MdNode) {
	if (
		node.type === 'link' &&
		node.url &&
		REPO_URL.test(node.url) &&
		plainText(node).trim().toLowerCase() === 'sandcastle'
	) {
		node.url = SANDCASTLE_DOCS_PATH
	}
	node.children?.forEach(rewrite)
}

export function remarkSandcastleLinks() {
	return (tree: unknown) => rewrite(tree as MdNode)
}
