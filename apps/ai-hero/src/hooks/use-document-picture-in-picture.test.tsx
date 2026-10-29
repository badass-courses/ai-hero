// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDocumentPictureInPicture } from './use-document-picture-in-picture'

type Hook = ReturnType<typeof useDocumentPictureInPicture>

function fakeWindow() {
	const pip = document.implementation.createHTMLDocument('')
	return Object.assign(new EventTarget(), {
		document: pip,
		close: vi.fn(),
	}) as unknown as Window & { close: ReturnType<typeof vi.fn> }
}

describe('useDocumentPictureInPicture', () => {
	let pip: ReturnType<typeof fakeWindow>
	let hook: Hook
	let container: HTMLDivElement
	let root: ReturnType<typeof createRoot>

	function Probe() {
		hook = useDocumentPictureInPicture()
		return null
	}

	beforeEach(async () => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		pip = fakeWindow()
		window.documentPictureInPicture = {
			requestWindow: vi.fn(() => Promise.resolve(pip)),
			window: null,
		}
		container = document.createElement('div')
		root = createRoot(container)
		await act(async () => root.render(<Probe />))
		await act(async () => hook.open({ width: 420, height: 720 }))
	})

	afterEach(() => {
		delete window.documentPictureInPicture
		vi.unstubAllGlobals()
	})

	it('closes the window when it is dropped', async () => {
		expect(hook.pipWindow).toBe(pip)
		await act(async () => hook.close())
		expect(hook.pipWindow).toBeNull()
		expect(pip.close).toHaveBeenCalled()
		root.unmount()
	})

	it('closes the window when its owner unmounts', () => {
		expect(pip.close).not.toHaveBeenCalled()
		act(() => root.unmount())
		expect(pip.close).toHaveBeenCalled()
	})
})
