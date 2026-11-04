// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchBox } from './searchbox'

const { search } = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('react-instantsearch', () => ({
	useSearchBox: ({ queryHook }: { queryHook: (query: string, search: (query: string) => void) => void }) => ({
		refine: (query: string) => queryHook(query, search),
		clear: vi.fn(),
		isSearchStalled: false,
		query: '',
	}),
}))
vi.mock('nuqs', () => ({ useQueryState: () => ['initial'] }))
vi.mock('@coursebuilder/ui', () => ({
	Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} />
	),
}))

let root: Root
let container: HTMLDivElement

function type(value: string) {
	act(() => {
		const input = container.querySelector('input')!
		input.value = value
		input.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

function submit() {
	act(() => {
		container.querySelector('form')!.dispatchEvent(
			new Event('submit', { bubbles: true, cancelable: true }),
		)
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	search.mockClear()
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
	act(() => root.render(<SearchBox />))
})

afterEach(() => {
	act(() => root.unmount())
	container.remove()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('SearchBox debounce', () => {
	it('shows input immediately but searches only once after five fast characters', () => {
		expect(container.querySelector('input')!.value).toBe('initial')
		for (const query of ['h', 'he', 'hel', 'hell', 'hello']) {
			type(query)
			act(() => vi.advanceTimersByTime(40))
		}
		expect(container.querySelector('input')!.value).toBe('hello')
		expect(search).not.toHaveBeenCalled()
		act(() => vi.advanceTimersByTime(259))
		expect(search).not.toHaveBeenCalled()
		act(() => vi.advanceTimersByTime(1))
		expect(search).toHaveBeenCalledTimes(1)
		expect(search).toHaveBeenCalledWith('hello')
	})

	it('flushes immediately when Enter submits, without a delayed duplicate', () => {
		type('hello')
		submit()
		expect(search).toHaveBeenCalledTimes(1)
		expect(search).toHaveBeenCalledWith('hello')
		act(() => vi.runAllTimers())
		expect(search).toHaveBeenCalledTimes(1)
	})

	it('clears immediately and cancels the pending search', () => {
		type('hello')
		type('')
		expect(search).toHaveBeenCalledTimes(1)
		expect(search).toHaveBeenCalledWith('')
		act(() => vi.runAllTimers())
		expect(search).toHaveBeenCalledTimes(1)
	})

	it('cancels pending work on unmount', () => {
		type('hello')
		act(() => root.render(null))
		act(() => vi.runAllTimers())
		expect(search).not.toHaveBeenCalled()
	})

	it('does not repeat a completed search on submit', () => {
		type('hello')
		act(() => vi.advanceTimersByTime(300))
		submit()
		expect(search).toHaveBeenCalledTimes(1)
		expect(search).toHaveBeenCalledWith('hello')
	})
})
