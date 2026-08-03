/**
 * Stamps every task-list checkbox with its position among the document's
 * checkboxes (`data-checkbox-index`), at COMPILE time.
 *
 * The index used to be assigned at render time, from a counter in the compile
 * closure — one mutable `checkboxIndex` shared by every render of that
 * compile. With compiles cached across requests (`compiledMdxCache`), that
 * counter kept counting: the first warm-cache render numbered its checkboxes
 * from where the previous render stopped, and `MDXCheckbox` persistence
 * (keyed `${lessonId}-checkbox-${index}`) read and wrote under unstable keys.
 * Numbering during compile bakes the index into the cached tree, so it is
 * identical for every render by construction.
 */

type TreeNode = {
	type: string
	tagName?: string
	name?: string | null
	properties?: Record<string, unknown>
	attributes?: {
		type: string
		name?: string
		value?: unknown
	}[]
	children?: TreeNode[]
}

function isMarkdownCheckbox(node: TreeNode): boolean {
	return (
		node.type === 'element' &&
		node.tagName === 'input' &&
		node.properties?.type === 'checkbox'
	)
}

/** Hand-authored `<input type="checkbox" />` JSX — parity with the markdown form. */
function isJsxCheckbox(node: TreeNode): boolean {
	return (
		(node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
		node.name === 'input' &&
		(node.attributes ?? []).some(
			(attribute) =>
				attribute.type === 'mdxJsxAttribute' &&
				attribute.name === 'type' &&
				attribute.value === 'checkbox',
		)
	)
}

export function rehypeNumberCheckboxes() {
	return (tree: unknown) => {
		let index = 0
		const visit = (node: TreeNode): void => {
			if (isMarkdownCheckbox(node)) {
				node.properties = { ...node.properties, dataCheckboxIndex: index++ }
			} else if (isJsxCheckbox(node)) {
				node.attributes = [
					...(node.attributes ?? []),
					{
						type: 'mdxJsxAttribute',
						name: 'data-checkbox-index',
						value: String(index++),
					},
				]
			}
			for (const child of node.children ?? []) visit(child)
		}
		visit(tree as TreeNode)
	}
}
