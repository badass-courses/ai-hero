'use client'

import * as React from 'react'

import { formatCompactCountdown } from './format'

export function CompactCountdown({ expires }: { expires: string | Date }) {
	const expiresDate = React.useMemo(
		() => (expires instanceof Date ? expires : new Date(expires)),
		[expires],
	)

	const [text, setText] = React.useState<string | null>(() =>
		formatCompactCountdown(expiresDate),
	)

	React.useEffect(() => {
		const update = () => setText(formatCompactCountdown(expiresDate))
		update()
		const id = setInterval(update, 60_000)
		return () => clearInterval(id)
	}, [expiresDate])

	if (!text) return null
	return <span>{text}</span>
}
