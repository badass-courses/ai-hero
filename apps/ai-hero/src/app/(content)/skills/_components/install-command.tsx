'use client'

import * as React from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

export function InstallCommand({
	command,
	className,
}: {
	command: string
	className?: string
}) {
	const inputRef = React.useRef<HTMLInputElement>(null)
	const [copied, setCopied] = React.useState(false)
	const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

	React.useEffect(() => {
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current)
		}
	}, [])

	const handleSelect = () => inputRef.current?.select()

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(command)
			inputRef.current?.select()
			setCopied(true)
			if (resetTimer.current) clearTimeout(resetTimer.current)
			resetTimer.current = setTimeout(() => setCopied(false), 1800)
		} catch {
			// Fallback: select the text so the user can copy manually
			inputRef.current?.select()
		}
	}

	return (
		<div
			className={cn(
				'border-border bg-muted/40 group focus-within:ring-ring relative flex h-12 w-full items-stretch border focus-within:ring-2 focus-within:ring-offset-0',
				className,
			)}
			data-copied={copied || undefined}
		>
			<span
				aria-hidden
				className="text-primary flex shrink-0 select-none items-center pl-4 pr-2 font-mono text-sm font-semibold"
			>
				$
			</span>
			<input
				ref={inputRef}
				type="text"
				readOnly
				value={command}
				onClick={handleSelect}
				onFocus={handleSelect}
				spellCheck={false}
				autoCorrect="off"
				autoCapitalize="off"
				aria-label="Install command"
				className="text-foreground placeholder:text-foreground/60 min-w-0 flex-1 cursor-text bg-transparent pr-3 font-mono text-sm outline-none"
			/>
			<button
				type="button"
				onClick={handleCopy}
				aria-label={copied ? 'Copied to clipboard' : 'Copy install command'}
				className="border-border hover:bg-muted relative flex aspect-square h-full shrink-0 items-center justify-center border-l transition-colors"
			>
				<span aria-live="polite" aria-atomic="true" className="sr-only">
					{copied ? 'Copied' : ''}
				</span>
				<span className="relative inline-flex h-4 w-4 items-center justify-center">
					<Copy
						aria-hidden
						className={cn(
							'absolute h-4 w-4 transition-all duration-200 ease-out',
							copied ? 'scale-50 opacity-0' : 'scale-100 opacity-100',
						)}
					/>
					<Check
						aria-hidden
						className={cn(
							'text-primary absolute h-4 w-4 transition-all duration-200 ease-out',
							copied ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
						)}
					/>
				</span>
			</button>
		</div>
	)
}
