'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowUpRight, Check, Copy } from 'lucide-react'

import { toast } from '@coursebuilder/ui/primitives/use-toast'
import { cn } from '@coursebuilder/ui/utils/cn'

import { SKILL_SOURCE, invocationName, skillInstallCommand } from './skill-meta'

/**
 * The skill page's one primary action, pinned to the bottom below 900px
 * (Mobile Patterns § 3a: "The page's one primary action pins to the bottom as
 * a sticky bar").
 *
 * Why a second copy affordance rather than making the head panel sticky: on
 * mobile the install panel sits directly under the title, so it scrolls away
 * within the first screen and a reader who decides to install after reading the
 * page has to scroll back up to a thing they have already passed. The bar is
 * the same action, available at the moment the decision is actually made.
 *
 * `fixed`, not `sticky`: sticky would need an unbroken containing block from
 * the article root, and the post page's `<article>` owns section borders via
 * `[&>*+*]`, so a sticky wrapper would land in the middle of that sequence and
 * take a hairline it should not have.
 *
 * Hidden entirely at `desk:` — above 900px the install panel is in the head and
 * a fixed bar would be covering content for no reason.
 */
export function SkillStickyAction({ slug }: { slug: string }) {
	const command = skillInstallCommand(slug)
	const [copied, setCopied] = React.useState(false)
	const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

	React.useEffect(() => {
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current)
		}
	}, [])

	// Clearance for a `fixed` bar has to be applied to the document, not to this
	// page's markup: the footer is rendered by `HubLayout`, ABOVE this page in
	// the tree, so any spacer we render lands before the footer and the bar
	// still covers the footer's last row at full scroll. `.has-sticky-action`
	// (globals.css) pads the body past both, and only below 900px.
	React.useEffect(() => {
		document.body.classList.add('has-sticky-action')
		return () => document.body.classList.remove('has-sticky-action')
	}, [])

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(command)
			setCopied(true)
			toast({ title: 'Copied to clipboard' })
			if (resetTimer.current) clearTimeout(resetTimer.current)
			resetTimer.current = setTimeout(() => setCopied(false), 1800)
		} catch {
			// Clipboard is permission-gated and can refuse. There is no text to
			// select down here, so send the reader to the panel that has it.
			toast({
				title: 'Copy the command from the top of the page',
				variant: 'destructive',
			})
		}
	}

	return (
		<div
			// The safe-area inset is padding on the OUTER element and the visual
			// padding sits on the inner row, so the inset is filled by the bar's own
			// background. Filled the other way round, the home-indicator strip on an
			// iPhone shows page content sliding under a floating bar.
			className="bg-background/95 border-border fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md desk:hidden print:hidden"
		>
			<div className="flex items-center gap-2.5 px-4 py-3">
				<button
					type="button"
					onClick={handleCopy}
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring flex h-11 flex-1 items-center justify-center gap-2 rounded-[9px] text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2"
				>
					<span aria-live="polite" aria-atomic="true" className="sr-only">
						{copied ? 'Copied' : ''}
					</span>
					<span className="relative inline-flex size-4 items-center justify-center">
						<Copy
							aria-hidden
							className={cn(
								'ease-out-quart absolute size-4 transition-all duration-300 motion-reduce:transition-none',
								copied ? 'scale-50 opacity-0' : 'scale-100 opacity-100',
							)}
						/>
						<Check
							aria-hidden
							className={cn(
								'ease-out-quart absolute size-4 transition-all duration-300 motion-reduce:transition-none',
								copied ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
							)}
						/>
					</span>
					Copy install command
				</button>
				<Link
					href={SKILL_SOURCE.href}
					target="_blank"
					rel="noreferrer"
					aria-label={`View /${invocationName(slug)} source on ${SKILL_SOURCE.label}`}
					className="border-input text-[color:var(--ah-fg-subtle)] hover:text-foreground hover:border-foreground/30 focus-visible:ring-ring flex size-11 flex-none items-center justify-center rounded-[9px] border transition focus-visible:outline-none focus-visible:ring-2"
				>
					<ArrowUpRight aria-hidden className="size-4" />
				</Link>
			</div>
		</div>
	)
}
