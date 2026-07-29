import {
	createCalloutLineAutoInsertRemarkPlugin,
	type CalloutLineAutoInsertPayload,
} from '@/lib/callout-line-autoinsert'
import { describe, expect, it } from 'vitest'

const payload: CalloutLineAutoInsertPayload = {
	variant: 'course',
	label: 'Going deeper?',
	href: '/cohorts/real-engineers',
	linkText: 'Join the cohort',
}

/** Run the plugin over a tree, mutating it in place like unified does. */
function transform(tree: Record<string, any>, p = payload) {
	createCalloutLineAutoInsertRemarkPlugin(p)()(tree)
	return tree
}

const h2 = (text: string) => ({
	type: 'heading',
	depth: 2,
	children: [{ type: 'text', value: text }],
})
const para = (value: string) => ({
	type: 'paragraph',
	children: [{ type: 'text', value }],
})
const jsx = (name: string, attributes: Record<string, any>[] = []) => ({
	type: 'mdxJsxFlowElement',
	name,
	attributes,
	children: [],
})
const intentAttr = (value = 'skill') => ({
	type: 'mdxJsxAttribute',
	name: 'intent',
	value,
})

const names = (tree: Record<string, any>) =>
	tree.children.map(
		(child: any) => child.name ?? `${child.type}:${child.depth ?? ''}`,
	)

describe('callout-line auto-insert — placement', () => {
	it('splices the callout immediately before the 2nd h2', () => {
		const tree = {
			type: 'root',
			children: [h2('One'), para('a'), h2('Two'), para('b')],
		}
		transform(tree)

		expect(names(tree)).toEqual([
			'heading:2',
			'paragraph:',
			'Callout',
			'heading:2',
			'paragraph:',
		])
	})

	it('builds an intent-marked Callout carrying the label and link', () => {
		const tree = { type: 'root', children: [h2('One'), h2('Two')] }
		transform(tree)

		const callout = tree.children[1] as any
		expect(callout.name).toBe('Callout')
		expect(callout.attributes).toEqual([
			{ type: 'mdxJsxAttribute', name: 'intent', value: 'course' },
		])

		const [text, link] = callout.children[0].children
		// Trailing space so the label doesn't run into the link text.
		expect(text).toEqual({ type: 'text', value: 'Going deeper? ' })
		expect(link.type).toBe('link')
		expect(link.url).toBe('/cohorts/real-engineers')
		expect(link.children[0].value).toBe('Join the cohort')
	})

	it('omits the label node entirely when the label is empty', () => {
		const tree = { type: 'root', children: [h2('One'), h2('Two')] }
		transform(tree, { ...payload, label: '' })

		const children = (tree.children[1] as any).children[0].children
		expect(children).toHaveLength(1)
		expect(children[0].type).toBe('link')
	})

	it('targets the 2nd h2 only — later h2s are untouched', () => {
		const tree = {
			type: 'root',
			children: [h2('One'), h2('Two'), h2('Three')],
		}
		transform(tree)

		expect(names(tree)).toEqual([
			'heading:2',
			'Callout',
			'heading:2',
			'heading:2',
		])
	})

	it('counts only top-level h2s — h3s and nested headings do not qualify', () => {
		const tree = {
			type: 'root',
			children: [
				h2('One'),
				{ type: 'heading', depth: 3, children: [] },
				{ type: 'heading', depth: 3, children: [] },
			],
		}
		transform(tree)

		expect(names(tree)).toEqual(['heading:2', 'heading:3', 'heading:3'])
	})
})

describe('callout-line auto-insert — no-op cases', () => {
	it('does nothing with fewer than two h2s', () => {
		const tree = { type: 'root', children: [h2('Only one'), para('a')] }
		transform(tree)
		expect(names(tree)).toEqual(['heading:2', 'paragraph:'])
	})

	it('does nothing on an empty document', () => {
		const tree = { type: 'root', children: [] }
		transform(tree)
		expect(tree.children).toEqual([])
	})

	it('never throws on an unexpected tree shape', () => {
		expect(() => transform({ type: 'root' } as any)).not.toThrow()
		expect(() => transform({} as any)).not.toThrow()
		expect(() =>
			transform({
				type: 'root',
				children: [null, undefined, h2('a'), h2('b')],
			} as any),
		).not.toThrow()
	})
})

describe('callout-line auto-insert — suppression', () => {
	it('is suppressed by a manual PromoCard', () => {
		const tree = {
			type: 'root',
			children: [h2('One'), jsx('PromoCard'), h2('Two')],
		}
		transform(tree)
		expect(names(tree)).toEqual(['heading:2', 'PromoCard', 'heading:2'])
	})

	it('is suppressed by a Callout WITH an intent attribute', () => {
		const tree = {
			type: 'root',
			children: [h2('One'), jsx('Callout', [intentAttr()]), h2('Two')],
		}
		transform(tree)
		expect(names(tree)).toEqual(['heading:2', 'Callout', 'heading:2'])
	})

	it('is NOT suppressed by a bare Callout — that is an informational note', () => {
		const tree = {
			type: 'root',
			children: [h2('One'), jsx('Callout'), h2('Two')],
		}
		transform(tree)
		expect(names(tree)).toEqual([
			'heading:2',
			'Callout',
			'Callout',
			'heading:2',
		])
	})

	it('is suppressed by a placement that appears AFTER the 2nd h2', () => {
		// The scan is a full pass before the splice, so a promo further down the
		// article still counts — otherwise a post with a hand-placed card at the
		// end would get an auto-inserted one too.
		const tree = {
			type: 'root',
			children: [h2('One'), h2('Two'), para('a'), jsx('PromoCard')],
		}
		transform(tree)
		expect(names(tree)).toEqual([
			'heading:2',
			'heading:2',
			'paragraph:',
			'PromoCard',
		])
	})

	it('ignores a non-intent attribute on a Callout', () => {
		const tree = {
			type: 'root',
			children: [
				h2('One'),
				jsx('Callout', [
					{ type: 'mdxJsxAttribute', name: 'icon', value: '💡' },
				]),
				h2('Two'),
			],
		}
		transform(tree)
		expect(names(tree)).toHaveLength(4)
	})
})
