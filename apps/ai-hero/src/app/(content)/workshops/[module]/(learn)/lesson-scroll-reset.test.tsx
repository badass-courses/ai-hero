// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ pathname: '/workshops/w/lesson-1' }))
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))

import { LessonScrollReset } from './lesson-scroll-reset'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('LessonScrollReset', () => {
	let root: Root
	let host: HTMLElement
	let scrollTo: ReturnType<typeof vi.fn>

	function render() {
		act(() => root.render(<LessonScrollReset />))
	}
	function goTo(pathname: string) {
		nav.pathname = pathname
		render()
	}

	beforeEach(() => {
		nav.pathname = '/workshops/w/lesson-1'
		window.location.hash = ''
		scrollTo = vi.fn()
		window.scrollTo = scrollTo as unknown as typeof window.scrollTo
		host = document.createElement('div')
		document.body.appendChild(host)
		root = createRoot(host)
	})
	afterEach(() => {
		act(() => root.unmount())
		host.remove()
		window.location.hash = ''
	})

	it('leaves the first render alone', () => {
		render()
		expect(scrollTo).not.toHaveBeenCalled()
	})

	it('scrolls to the top when the lesson changes', () => {
		render()
		goTo('/workshops/w/lesson-2')
		expect(scrollTo).toHaveBeenCalledWith({
			top: 0,
			left: 0,
			behavior: 'instant',
		})
	})

	it('does nothing on a re-render without a navigation', () => {
		render()
		render()
		expect(scrollTo).not.toHaveBeenCalled()
	})

	it('keeps the restored position on back and forward', () => {
		render()
		window.dispatchEvent(new PopStateEvent('popstate'))
		goTo('/workshops/w/lesson-0')
		expect(scrollTo).not.toHaveBeenCalled()

		goTo('/workshops/w/lesson-1')
		expect(scrollTo).toHaveBeenCalledTimes(1)
	})

	it('leaves a #fragment target to the router', () => {
		render()
		window.location.hash = '#setup'
		goTo('/workshops/w/lesson-2')
		expect(scrollTo).not.toHaveBeenCalled()
	})
})
