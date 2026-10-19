'use client'

import React, { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

export function CopyButton({
	text,
	className,
}: {
	text: string
	className?: string
}) {
	const [copied, setCopied] = useState(false)

	return (
		<Button
			variant="outline"
			size="icon"
			className={cn(
				// Top right, where a reader looks for it; 28px so it also sits
				// inside the 33px title bar a terminal block carries.
				'absolute right-1.5 top-1 z-10 size-7 rounded opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100',
				className,
			)}
			aria-label="Copy to clipboard"
			onClick={() => {
				navigator.clipboard.writeText(text)
				setCopied(true)
				setTimeout(() => setCopied(false), 1200)
			}}
		>
			{copied ? <Check size={14} /> : <Copy size={14} />}
		</Button>
	)
}
