'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { Check, Copy } from 'lucide-react'

import { toast } from '@coursebuilder/ui/primitives/use-toast'
import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The spec's `.ah-command` row: `$` prompt, the command, a 28px copy button.
 *
 * The command is a readonly `<input>` rather than a `<span>` so a reader who
 * distrusts clipboard buttons can still select the exact string with a click —
 * and because an input gives us `white-space: nowrap; overflow: auto` for free.
 * A shell command must never wrap: a wrapped command reads as two commands.
 *
 * The `$` and the button are `aria-hidden` decoration and are NOT part of what
 * gets copied.
 */
export function InstallCommand({
	command,
	className,
	label = 'Install command',
}: {
	command: string
	className?: string
	/** Accessible name for the field and the copy button's target. */
	label?: string
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
			toast({ title: 'Copied to clipboard' })
			if (resetTimer.current) clearTimeout(resetTimer.current)
			resetTimer.current = setTimeout(() => setCopied(false), 1800)
		} catch {
			// Clipboard is permission-gated and can just say no. Select the text so
			// the reader can still copy it by hand.
			inputRef.current?.select()
			toast({ title: 'Press ⌘C to copy', variant: 'destructive' })
		}
	}

	return (
		<div
			className={cn(
				// Dark-mode `--card` is the spec's code surface; light-mode `--card` is
				// pure white, which makes a command block vanish into the page, so
				// light falls back to the raised band (`--muted`).
				'border-border bg-muted focus-within:ring-ring dark:bg-card flex w-full items-center gap-3 rounded-[9px] border px-3.5 py-3 focus-within:ring-2 focus-within:ring-offset-0',
				className,
			)}
			data-copied={copied || undefined}
		>
			<span
				aria-hidden
				className={cn(
					TYPE.command,
					'flex-none select-none text-[color:var(--ah-fg-faint)]',
				)}
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
				aria-label={label}
				className={cn(
					TYPE.command,
					'text-foreground/90 min-w-0 flex-1 cursor-text bg-transparent outline-none',
				)}
			/>
			<button
				type="button"
				onClick={handleCopy}
				aria-label={copied ? 'Copied to clipboard' : `Copy ${label.toLowerCase()}`}
				className="border-border text-[color:var(--ah-fg-subtle)] hover:text-foreground hover:border-foreground/30 focus-visible:ring-ring ml-auto flex size-7 flex-none items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
			>
				<span aria-live="polite" aria-atomic="true" className="sr-only">
					{copied ? 'Copied' : ''}
				</span>
				<span className="relative inline-flex size-3.5 items-center justify-center">
					<Copy
						aria-hidden
						className={cn(
							'ease-out-quart absolute size-3.5 transition-all duration-300 motion-reduce:transition-none',
							copied ? 'scale-50 opacity-0' : 'scale-100 opacity-100',
						)}
					/>
					<Check
						aria-hidden
						className={cn(
							'text-primary ease-out-quart absolute size-3.5 transition-all duration-300 motion-reduce:transition-none',
							copied ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
						)}
					/>
				</span>
			</button>
		</div>
	)
}
