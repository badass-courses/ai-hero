/**
 * Wraps every table in the compiled MDX tree with the `TableWrapper` MDX
 * component (responsive horizontal scroll + zoom dialog) unless the table
 * is already inside a hand-authored `<TableWrapper>`.
 *
 * Runs as a rehype plugin so it sees ancestry, which a `table` entry in the
 * components map cannot: markdown tables nested in an explicit wrapper must
 * not double-wrap, and literal `<table>` JSX never resolves through the
 * components map at all.
 */

type TreeNode = {
	type: string
	tagName?: string
	name?: string | null
	children?: TreeNode[]
}

function isTable(node: TreeNode): boolean {
	if (node.type === 'element' && node.tagName === 'table') return true
	return node.type === 'mdxJsxFlowElement' && node.name === 'table'
}

function isTableWrapper(node: TreeNode): boolean {
	return node.type === 'mdxJsxFlowElement' && node.name === 'TableWrapper'
}

function wrapTables(node: TreeNode): void {
	if (!node.children) return
	node.children = node.children.map((child) => {
		// A hand-authored wrapper keeps its subtree exactly as authored.
		if (isTableWrapper(child)) return child
		if (isTable(child)) {
			return {
				type: 'mdxJsxFlowElement',
				name: 'TableWrapper',
				attributes: [],
				children: [child],
			}
		}
		wrapTables(child)
		return child
	})
}

export function rehypeAutoTableWrap() {
	return (tree: unknown) => {
		wrapTables(tree as TreeNode)
	}
}
