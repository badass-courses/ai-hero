'use client'

import * as React from 'react'

/**
 * A moment in the viewer's own time zone. The server can't know that zone, so
 * the first render shows the cohort's (with its name) and the browser swaps in
 * its own after hydration.
 */
export function LocalTime({
	iso,
	fallbackTimeZone,
	options,
}: {
	iso: string
	fallbackTimeZone: string
	options: Intl.DateTimeFormatOptions
}) {
	const format = (timeZone: string, timeZoneName?: 'short') =>
		new Intl.DateTimeFormat('en-US', { ...options, timeZone, timeZoneName }).format(
			new Date(iso),
		)
	// The server's zone is named only where a time of day would otherwise mislead.
	const [text, setText] = React.useState(() =>
		format(fallbackTimeZone, options.hour ? 'short' : undefined),
	)

	React.useEffect(() => {
		setText(format(Intl.DateTimeFormat().resolvedOptions().timeZone))
		// `options` is a literal at every call site; the moment is what changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [iso])

	return <time dateTime={iso}>{text}</time>
}
