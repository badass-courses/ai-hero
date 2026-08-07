/**
 * Rewrites absolute links that point back at this site to root-relative paths,
 * so `https://aihero.dev/skills-grill-me` renders as `/skills-grill-me`.
 *
 * Skill articles are authored in a GitHub repo, where a bare `/skills-grill-me`
 * would not resolve — so they carry the full origin. On the site that origin is
 * noise with teeth: `rehype-external-links` sees a foreign URL and stamps the
 * link `target="_blank"`, so an internal link opens a new tab and pays a full
 * document load instead of a client-side navigation.
 *
 * This runs BEFORE `rehype-external-links` in the pipeline — by the time that
 * plugin looks, the href is relative and it correctly leaves it alone. The
 * components map then renders relative hrefs through `next/link`.
 */

const INTERNAL_HOSTS = new Set(['aihero.dev', 'www.aihero.dev'])

/**
 * Root-relative path for an href pointing at this site, or `null` if the href
 * is external, already relative, or not a parseable http(s) URL.
 */
export function toInternalHref(href: string): string | null {
	if (!/^https?:\/\//i.test(href)) return null

	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}

	if (!INTERNAL_HOSTS.has(url.hostname.toLowerCase())) return null

	// A port means a different service, not us — and a root-relative path
	// cannot carry one, so rewriting would silently redirect to this site's
	// default port. `URL` already blanks the port when it is the protocol
	// default, so `https://aihero.dev:443/x` still reads as ours.
	if (url.port !== '') return null

	return `${url.pathname}${url.search}${url.hash}`
}

type TreeNode = {
	type: string
	tagName?: string
	name?: string | null
	properties?: Record<string, unknown>
	attributes?: Array<{ type: string; name?: string | null; value?: unknown }>
	children?: TreeNode[]
}

function rewriteNode(node: TreeNode): void {
	if (node.type === 'element' && node.tagName === 'a' && node.properties) {
		const href = node.properties.href
		if (typeof href === 'string') {
			const internal = toInternalHref(href)
			if (internal) node.properties.href = internal
		}
	}

	// Hand-authored `<a>` / `<Link>` JSX never becomes an `element` node.
	if (
		(node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') &&
		(node.name === 'a' || node.name === 'Link')
	) {
		for (const attribute of node.attributes ?? []) {
			if (
				attribute.type === 'mdxJsxAttribute' &&
				attribute.name === 'href' &&
				typeof attribute.value === 'string'
			) {
				const internal = toInternalHref(attribute.value)
				if (internal) attribute.value = internal
			}
		}
	}

	for (const child of node.children ?? []) rewriteNode(child)
}

export function rehypeInternalLinks() {
	return (tree: unknown) => {
		rewriteNode(tree as TreeNode)
	}
}
