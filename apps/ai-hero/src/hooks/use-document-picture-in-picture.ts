'use client'

import * as React from 'react'

type DocumentPictureInPicture = {
	requestWindow: (options?: {
		width?: number
		height?: number
	}) => Promise<Window>
	window: Window | null
}

declare global {
	interface Window {
		documentPictureInPicture?: DocumentPictureInPicture
	}
}

/**
 * An always-on-top window (Document Picture-in-Picture, Chromium only) that
 * React can portal into. The page's stylesheets and theme class are copied
 * over so components render as they do in the page. `supported` is false
 * until mount, and stays false where the API is missing.
 */
export function useDocumentPictureInPicture() {
	const [supported, setSupported] = React.useState(false)
	const [pipWindow, setPipWindow] = React.useState<Window | null>(null)

	React.useEffect(() => {
		setSupported('documentPictureInPicture' in window)
	}, [])

	const open = React.useCallback(
		async (size: { width: number; height: number }) => {
			const api = window.documentPictureInPicture
			if (!api) return
			const pip = await api.requestWindow(size)
			for (const node of document.head.querySelectorAll(
				'link[rel="stylesheet"], style',
			)) {
				pip.document.head.append(node.cloneNode(true))
			}
			pip.document.documentElement.className =
				document.documentElement.className
			pip.document.body.className = document.body.className
			// Let a full-height child fill the window.
			pip.document.body.style.cssText = 'margin:0;height:100vh'
			pip.addEventListener('pagehide', () => setPipWindow(null), {
				once: true,
			})
			setPipWindow(pip)
		},
		[],
	)

	// The window only holds a portal from this page, so it closes when it is
	// dropped and when the page that owns it unmounts.
	React.useEffect(() => {
		if (!pipWindow) return
		return () => pipWindow.close()
	}, [pipWindow])

	const close = React.useCallback(() => setPipWindow(null), [])

	return { supported, pipWindow, open, close }
}
