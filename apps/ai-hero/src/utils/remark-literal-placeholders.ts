/**
 * Renders a bare-name MDX expression — `{course}`, `{input.courseTitle}` — as
 * the literal text it was typed as.
 *
 * Content MDX is compiled with no `scope`, so a bare name can never resolve:
 * it is always an author's placeholder in prose ("Refund requested -
 * {course}"). It compiles cleanly and then throws `ReferenceError` at RENDER
 * time, past `compileMDX`'s escaped-markdown fallback, which takes the whole
 * page down. Real expressions (`{' '}`, `{/* comment *\/}`, `{2 * 3}`) are
 * left alone.
 */

type TreeNode = {
	type: string
	value?: string
	children?: TreeNode[]
}

const BARE_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/

function isBareNameExpression(node: TreeNode): boolean {
	return (
		(node.type === 'mdxTextExpression' || node.type === 'mdxFlowExpression') &&
		BARE_NAME.test((node.value ?? '').trim())
	)
}

function literal(node: TreeNode): TreeNode {
	const text: TreeNode = { type: 'text', value: `{${node.value}}` }
	return node.type === 'mdxFlowExpression'
		? { type: 'paragraph', children: [text] }
		: text
}

export function remarkLiteralPlaceholders() {
	return (tree: unknown) => {
		const visit = (node: TreeNode): void => {
			if (!node.children) return
			node.children = node.children.map((child) =>
				isBareNameExpression(child) ? literal(child) : child,
			)
			for (const child of node.children) visit(child)
		}
		visit(tree as TreeNode)
	}
}
