// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileNavigation } from './mobile-navigation'

vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))

type Props = React.ComponentProps<typeof MobileNavigation>
const baseProps: Props = {
	isMobileMenuOpen: false,
	setIsMobileMenuOpen: vi.fn(),
	onSearchOpen: vi.fn(),
	subscriberResolved: false,
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
	if (root) await act(async () => root?.unmount())
	container?.remove()
})

function expectFixedSlot(bar: Element, hasLink: boolean) {
	expect(bar.children).toHaveLength(3)
	const slot = bar.children[1]!
	expect(slot.classList.contains('size-9')).toBe(true)
	expect(slot.classList.contains('shrink-0')).toBe(true)
	expect(slot.tagName).toBe(hasLink ? 'A' : 'SPAN')
	if (hasLink) {
		expect(slot.getAttribute('href')).toBe('/newsletter')
		expect(slot.getAttribute('aria-label')).toBe('Subscribe to the newsletter')
	} else {
		expect(slot.getAttribute('aria-hidden')).toBe('true')
		expect(slot.classList.contains('invisible')).toBe(true)
		expect(slot.hasAttribute('tabindex')).toBe(false)
		expect(slot.querySelector('a, button, input, [tabindex]')).toBeNull()
	}
}

describe('mobile header newsletter slot', () => {
	it('reserves an invisible, non-focusable slot in the server markup', () => {
		const server = document.createElement('div')
		server.innerHTML = renderToStaticMarkup(<MobileNavigation {...baseProps} />)
		expectFixedSlot(server.firstElementChild!, false)
		expect(server.querySelector('a')).toBeNull()
	})

	it.each([true, false])(
		'keeps the same slot and neighbouring controls when resolved (subscriber: %s)',
		async (isSubscriber) => {
			;(
				globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
			).IS_REACT_ACT_ENVIRONMENT = true
			container = document.createElement('div')
			document.body.appendChild(container)
			root = createRoot(container)
			await act(async () => root?.render(<MobileNavigation {...baseProps} />))
			const bar = container.firstElementChild!
			const search = bar.children[0]
			const menu = bar.children[2]
			expectFixedSlot(bar, false)

			await act(async () =>
				root?.render(
					<MobileNavigation
						{...baseProps}
						subscriberResolved
						subscriber={isSubscriber ? { state: 'active' } : null}
					/>,
				),
			)
			expectFixedSlot(bar, !isSubscriber)
			expect(bar.children[0]).toBe(search)
			expect(bar.children[2]).toBe(menu)
		},
	)

	it('keeps the slot on minimal routes without a search control', () => {
		const server = document.createElement('div')
		server.innerHTML = renderToStaticMarkup(
			<MobileNavigation {...baseProps} showSearch={false} />,
		)
		expect(server.firstElementChild?.children).toHaveLength(2)
		expect(server.querySelector('[aria-label="Search"]')).toBeNull()
		expect(server.querySelector('span')?.className).toBe('invisible size-9 shrink-0')
	})
})
