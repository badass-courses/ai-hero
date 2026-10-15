// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Dialog, DialogTitle } from '@coursebuilder/ui'

import { FullscreenDialogContent } from './fullscreen-dialog-content'

describe('FullscreenDialogContent', () => {
	afterEach(() => {
		document.body.innerHTML = ''
		Reflect.deleteProperty(document, 'fullscreenElement')
		vi.unstubAllGlobals()
	})

	it.each([
		['the fullscreen element', true],
		['body', false],
	])('opens inside %s', async (_, isFullscreen) => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		const shell = document.createElement('div')
		const container = document.createElement('div')
		document.body.append(shell, container)
		Object.defineProperty(document, 'fullscreenElement', {
			configurable: true,
			get: () => (isFullscreen ? shell : null),
		})
		const root = createRoot(container)
		await act(async () =>
			root.render(
				<Dialog open>
					<FullscreenDialogContent aria-describedby={undefined}>
						<DialogTitle>Certificate</DialogTitle>
					</FullscreenDialogContent>
				</Dialog>,
			),
		)
		const dialog = document.querySelector('[role="dialog"]')
		expect(dialog).not.toBeNull()
		expect(shell.contains(dialog)).toBe(isFullscreen)
		await act(async () => root.unmount())
	})
})
