'use client'

import { useRef, useState } from 'react'

import { Button } from '@coursebuilder/ui'

export default function CopyToClipboard({
	articleRef,
}: {
	articleRef: React.RefObject<HTMLElement | null>
}) {
	const [copied, setCopied] = useState(false)

	const copyToClipboard = async () => {
		const article = articleRef.current
		if (!article) return

		const text = article.innerText
		await navigator.clipboard.writeText(text)

		setCopied(true)
		setTimeout(() => setCopied(false), 1200)
	}

	return (
		<Button
			variant="outline"
			onClick={copyToClipboard}
			className="absolute right-4 top-4"
		>
			{copied ? 'Copied' : 'Copy'}
		</Button>
	)
}
