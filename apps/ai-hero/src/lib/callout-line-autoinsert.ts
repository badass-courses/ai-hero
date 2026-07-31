/**
 * Callout-line auto-insert remark plugin (W1 §2).
 *
 * PURE + synchronous, mirroring `dictionary-autolink.ts`: a factory that
 * receives an already-resolved payload and returns a unified/remark transformer.
 * It does ZERO data fetching — the caller (`PostBody`) resolves the variant,
 * copy, and destination before compile and hands the decided line in as a
 * static payload. The plugin only decides WHETHER and WHERE to splice.
 *
 * Insertion (§2.1): scan top-level mdast children only; if there are fewer than
 * two `depth === 2` headings, do nothing; otherwise splice one `Callout`
 * `mdxJsxFlowElement` (intent-marked, with a paragraph child carrying the label
 * text + a link) immediately before the 2nd h2.
 *
 * Suppression (§2.2): if any manual cross-promo placement already exists — an
 * `mdxJsxFlowElement` named `PromoCard`, or one named `Callout` WITH an
 * `intent` attribute — skip auto-insertion entirely. A bare `<Callout>` (no
 * `intent`) is an informational note and must NOT suppress. Suppression scan and
 * h2 collection happen in one linear pass over the top-level children.
 *
 * Never throws: any unexpected tree shape results in a no-op.
 */

export type CalloutLineAutoInsertPayload = {
	variant: 'skill' | 'course' | 'resource'
	label: string
	href: string
	linkText: string
}

function hasIntentAttribute(node: Record<string, any>): boolean {
	const attributes = node.attributes
	if (!Array.isArray(attributes)) return false
	return attributes.some(
		(attribute) =>
			attribute &&
			attribute.type === 'mdxJsxAttribute' &&
			attribute.name === 'intent',
	)
}

function isSuppressingNode(node: Record<string, any>): boolean {
	if (!node || node.type !== 'mdxJsxFlowElement') return false
	if (node.name === 'PromoCard') return true
	if (node.name === 'Callout' && hasIntentAttribute(node)) return true
	return false
}

function buildCalloutNode(
	payload: CalloutLineAutoInsertPayload,
): Record<string, any> {
	const paragraphChildren: Array<Record<string, any>> = []

	if (payload.label) {
		paragraphChildren.push({ type: 'text', value: `${payload.label} ` })
	}

	paragraphChildren.push({
		type: 'link',
		url: payload.href,
		title: null,
		children: [{ type: 'text', value: payload.linkText }],
	})

	return {
		type: 'mdxJsxFlowElement',
		name: 'Callout',
		attributes: [
			{ type: 'mdxJsxAttribute', name: 'intent', value: payload.variant },
		],
		children: [
			{
				type: 'paragraph',
				children: paragraphChildren,
			},
		],
	}
}

export function createCalloutLineAutoInsertRemarkPlugin(
	payload: CalloutLineAutoInsertPayload,
) {
	return function calloutLineAutoInsertRemarkPlugin() {
		return function transformCalloutLineAutoInsert(tree: Record<string, any>) {
			try {
				if (!tree || !Array.isArray(tree.children)) return

				const children = tree.children
				let secondHeadingIndex = -1
				let headingCount = 0

				// Single linear pass over top-level children: detect any manual
				// cross-promo placement (suppression) AND locate the 2nd h2.
				for (let index = 0; index < children.length; index++) {
					const child = children[index]
					if (!child) continue

					if (isSuppressingNode(child)) return

					if (child.type === 'heading' && child.depth === 2) {
						headingCount += 1
						if (headingCount === 2) {
							secondHeadingIndex = index
						}
					}
				}

				if (headingCount < 2 || secondHeadingIndex < 0) return

				children.splice(secondHeadingIndex, 0, buildCalloutNode(payload))
			} catch {
				// Unexpected tree shape — no-op, never throw.
			}
		}
	}
}
