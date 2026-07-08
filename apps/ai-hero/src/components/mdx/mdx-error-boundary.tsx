'use client'

import * as React from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'

/**
 * Fallback shown when compiled MDX throws while rendering — most commonly a
 * body that references a component the renderer doesn't provide (e.g. a stray
 * `<ChooseScreenshot>`), which MDX turns into a hard `_missingMdxReference`
 * throw. Without a boundary that throw escapes the whole page and, at build
 * time, fails the static prerender of the entire deploy.
 */
function MdxErrorFallback({ error }: FallbackProps) {
	return (
		<div
			role="alert"
			className="not-prose border-destructive/30 bg-destructive/5 text-destructive my-6 rounded-md border p-4 text-sm"
		>
			<p className="font-medium">This section couldn’t be rendered.</p>
			<p className="mt-1 opacity-80">
				Part of this content references something that isn’t available right
				now. The rest of the page is unaffected.
			</p>
			{process.env.NODE_ENV === 'development' && error instanceof Error ? (
				<pre className="mt-2 overflow-x-auto text-xs opacity-70">
					{error.message}
				</pre>
			) : null}
		</div>
	)
}

/**
 * Wrap rendered MDX so a single bad body degrades to a helpful note instead of
 * taking down the page (or the build). Scope it to just the article content —
 * the surrounding page chrome stays intact.
 */
export function MdxErrorBoundary({ children }: { children: React.ReactNode }) {
	return (
		<ErrorBoundary FallbackComponent={MdxErrorFallback}>
			{children}
		</ErrorBoundary>
	)
}
