// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	LESSON_WIDE_ATTRIBUTE,
	LESSON_WIDE_BOOT_SCRIPT,
	LESSON_WIDE_KEY,
} from './lesson-wide-boot'
import { LessonWideToggle, writeLessonWide } from './lesson-wide-player'

const wide = () => document.documentElement.hasAttribute(LESSON_WIDE_ATTRIBUTE)
const boot = () => new Function(LESSON_WIDE_BOOT_SCRIPT)()

describe('the wide-player boot script', () => {
	beforeEach(() => {
		window.localStorage.clear()
		document.documentElement.removeAttribute(LESSON_WIDE_ATTRIBUTE)
	})

	it('sets the attribute before hydration when the viewer chose wide', () => {
		window.localStorage.setItem(LESSON_WIDE_KEY, '1')
		boot()
		expect(wide()).toBe(true)
	})

	it('leaves the page capped when the viewer did not', () => {
		boot()
		expect(wide()).toBe(false)
	})

	it('never throws when storage is blocked', () => {
		const getItem = vi
			.spyOn(Storage.prototype, 'getItem')
			.mockImplementation(() => {
				throw new Error('SecurityError')
			})
		expect(() => boot()).not.toThrow()
		expect(wide()).toBe(false)
		getItem.mockRestore()
	})
})

describe('LessonWideToggle', () => {
	let container: HTMLDivElement
	let root: ReturnType<typeof createRoot>

	beforeEach(async () => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		window.localStorage.clear()
		container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
		await act(async () => root.render(<LessonWideToggle />))
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
		writeLessonWide(false)
		vi.unstubAllGlobals()
	})

	const button = () => container.querySelector('button')!

	it('is off by default', () => {
		expect(button().getAttribute('aria-pressed')).toBe('false')
		expect(button().textContent).toContain('Wide player')
	})

	it('turns the wide player on and off, and remembers it', async () => {
		await act(async () => button().click())
		expect(button().getAttribute('aria-pressed')).toBe('true')
		expect(button().textContent).toContain('Normal width')
		expect(window.localStorage.getItem(LESSON_WIDE_KEY)).toBe('1')
		await act(async () => button().click())
		expect(button().getAttribute('aria-pressed')).toBe('false')
		expect(window.localStorage.getItem(LESSON_WIDE_KEY)).toBeNull()
	})

	it('follows a choice made in another tab', async () => {
		window.localStorage.setItem(LESSON_WIDE_KEY, '1')
		await act(async () =>
			window.dispatchEvent(new StorageEvent('storage', { key: LESSON_WIDE_KEY })),
		)
		expect(button().getAttribute('aria-pressed')).toBe('true')
	})
})
