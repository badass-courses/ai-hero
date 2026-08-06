'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { Check, Copy } from 'lucide-react'

import { toast } from '@coursebuilder/ui/primitives/use-toast'
import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The width the row is sized for, in characters.
 *
 * JetBrains Mono's advance is exactly `0.6em`, so at 12px a character is 7.2px
 * and the arithmetic is knowable without opening the page: 44ch = 317px, plus
 * 28 padding + 30 button + 12 gap = 387px, inside the 440px rail with room to
 * spare. Above this the command no longer fits, and that is a design change
 * rather than a content change — hence the assert rather than an ellipsis.
 */
const MAX_COMMAND_LENGTH = 44

/**
 * The spec's `.ah-command` row: `$` prompt, the command, a 30px copy button.
 *
 * A shell command must never wrap, because a wrapped command reads as two
 * commands. So the `<code>` refuses to wrap and scrolls horizontally within
 * its own box. It briefly did neither — it overflowed visibly, on the theory
 * that a bug you can see beats a bug you can't — and on a phone that overflow
 * widened the DOCUMENT, so every skill page scrolled sideways as a whole and
 * the header, prose and nav all sat clipped off-screen. The fit failure has to
 * be contained to this row; `MAX_COMMAND_LENGTH` below is where it gets
 * reported instead.
 *
 * `select-all` keeps the "click and get the exact string" behaviour.
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
	/** Accessible name for the command and the copy button's target. */
	label?: string
}) {
	const codeRef = React.useRef<HTMLElement>(null)
	const [copied, setCopied] = React.useState(false)
	const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

	if (process.env.NODE_ENV !== 'production' && command.length > MAX_COMMAND_LENGTH) {
		console.warn(
			`[InstallCommand] "${command}" is ${command.length} characters; the row is sized for ${MAX_COMMAND_LENGTH}, so the tail is only reachable by scrolling the row. Widen the rail or shorten the command.`,
		)
	}

	React.useEffect(() => {
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current)
		}
	}, [])

	const selectCommand = () => {
		const node = codeRef.current
		if (!node || typeof window === 'undefined') return
		const range = document.createRange()
		range.selectNodeContents(node)
		const selection = window.getSelection()
		selection?.removeAllRanges()
		selection?.addRange(range)
	}

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(command)
			selectCommand()
			setCopied(true)
			toast({ title: 'Copied to clipboard' })
			if (resetTimer.current) clearTimeout(resetTimer.current)
			// 1.2s: long enough to register as confirmation, short enough that the
			// solid accent does not settle in as a second filled button.
			resetTimer.current = setTimeout(() => setCopied(false), 1200)
		} catch {
			// Clipboard is permission-gated and can just say no. Select the text so
			// the reader can still copy it by hand.
			selectCommand()
			toast({ title: 'Press ⌘C to copy', variant: 'destructive' })
		}
	}

	return (
		<div
			className={cn(
				// The only filled surface left in the hero. Grey means "this is code"
				// now that the panels, the cell fills and the outer grid are gone.
				//
				// Dark-mode `--card` is the spec's code surface; light-mode `--card` is
				// pure white, which makes a command block vanish into the page, so
				// light falls back to the raised band (`--muted`).
				//
				// `flex-wrap` with an `order` swap, not a breakpoint: at 390 − 36
				// gutter = 354 the row is under its minimum, so the button leaves the
				// row and becomes a full-width 44px thumb target beneath the command.
				'border-border bg-muted focus-within:ring-ring dark:bg-card flex w-full flex-wrap items-center gap-x-3 gap-y-2.5 rounded-[9px] border px-3.5 py-3 focus-within:ring-2 focus-within:ring-offset-0',
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
			<code
				ref={codeRef}
				aria-label={label}
				className={cn(
					TYPE.command,
					// 11.5px under 380px: the last half-pixel that keeps the longest
					// command on one line on a 320px phone.
					//
					// `overflow-x-auto` is the containment, not a fit strategy: a command
					// that outgrows its column scrolls INSIDE this box instead of pushing
					// the document wider and dragging the whole page sideways. It is
					// `tabIndex` 0 because a scrollable region must be reachable by
					// keyboard.
					'text-foreground/90 min-w-0 flex-1 select-all overflow-x-auto overscroll-x-contain whitespace-nowrap bg-transparent text-[11.5px] sm:text-xs',
				)}
				tabIndex={0}
			>
				{command}
			</code>
			<button
				type="button"
				onClick={handleCopy}
				aria-label={copied ? 'Copied to clipboard' : `Copy ${label.toLowerCase()}`}
				className={cn(
					// Colour, as Amy asked, without a second filled button competing
					// with the page's one gold ask: a 14% accent wash under an
					// accent-coloured glyph. Confirmation goes SOLID, so the fill
					// arrives as state rather than sitting there as decoration.
					//
					// One declaration covers both themes — `--primary` already forks to
					// ink in light (DESIGN rule 7).
					'focus-visible:ring-ring ease-out-quart flex h-[30px] w-full flex-none items-center justify-center rounded-sm transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none min-[380px]:ml-auto min-[380px]:w-[30px]',
					copied
						? 'bg-accent-fill text-accent-fill-foreground'
						: 'bg-accent-fill/[0.14] text-primary hover:bg-accent-fill/25',
				)}
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
							'ease-out-quart absolute size-3.5 transition-all duration-300 motion-reduce:transition-none',
							copied ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
						)}
					/>
				</span>
			</button>
		</div>
	)
}
