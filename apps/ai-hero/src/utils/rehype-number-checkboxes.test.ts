import { describe, expect, it } from 'vitest'

import { rehypeNumberCheckboxes } from './rehype-number-checkboxes'

const checkbox = () => ({
	type: 'element',
	tagName: 'input',
	properties: { type: 'checkbox' },
})

describe('rehypeNumberCheckboxes', () => {
	it('numbers checkboxes in document order and leaves other inputs alone', () => {
		const tree = {
			type: 'root',
			children: [
				{ type: 'element', tagName: 'ul', children: [checkbox(), checkbox()] },
				{
					type: 'element',
					tagName: 'input',
					properties: { type: 'text' },
				},
				checkbox(),
			],
		}

		rehypeNumberCheckboxes()(tree)

		const [list, textInput, third] = tree.children as any[]
		expect(list.children[0].properties.dataCheckboxIndex).toBe(0)
		expect(list.children[1].properties.dataCheckboxIndex).toBe(1)
		expect(textInput.properties.dataCheckboxIndex).toBeUndefined()
		expect(third.properties.dataCheckboxIndex).toBe(2)
	})

	it('is stable across repeated renders because numbering happens once, at compile', () => {
		// The regression this plugin exists for: the index used to come from a
		// mutable counter in the compile closure, which the cross-request compile
		// cache kept alive — every warm render renumbered the same checkboxes.
		const tree = { type: 'root', children: [checkbox(), checkbox()] }
		rehypeNumberCheckboxes()(tree)
		const first = (tree.children as any[]).map(
			(node) => node.properties.dataCheckboxIndex,
		)
		expect(first).toEqual([0, 1])
	})

	it('numbers hand-authored JSX checkboxes in the same sequence', () => {
		const tree = {
			type: 'root',
			children: [
				checkbox(),
				{
					type: 'mdxJsxFlowElement',
					name: 'input',
					attributes: [
						{ type: 'mdxJsxAttribute', name: 'type', value: 'checkbox' },
					],
				},
			],
		}

		rehypeNumberCheckboxes()(tree)

		const [markdown, jsx] = tree.children as any[]
		expect(markdown.properties.dataCheckboxIndex).toBe(0)
		expect(
			jsx.attributes.find(
				(attribute: any) => attribute.name === 'data-checkbox-index',
			)?.value,
		).toBe('1')
	})
})
