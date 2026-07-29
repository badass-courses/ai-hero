'use client'

import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CheckIcon, ClipboardIcon } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import type { ButtonProps } from '@coursebuilder/ui/primitives/button'
import { cn } from '@coursebuilder/ui/utils/cn'

const easeOutQuint = [0.22, 1, 0.36, 1] as const

/**
 * Two ways to get the text, and the choice is a payload decision:
 *
 * - `markdown` — the source is already a prop. Fine for short bodies
 *   (dictionary entries).
 * - `sourceUrl` — the source is fetched on click. Long articles use this: the
 *   compiled MDX tree is already in the RSC payload, so passing the raw body as
 *   well doubles the cost of the page for a button most readers never press.
 *
 * Exactly one is required. `sourceUrl` wins when both are given.
 */
type CopySource =
	| { markdown: string; sourceUrl?: never }
	| { sourceUrl: string; markdown?: never }

export function CopyPageButton({
	markdown,
	sourceUrl,
	className,
	variant = 'outline',
	size = 'default',
	...rest
}: CopySource & ButtonProps) {
	const [copied, setCopied] = useState(false)
	const prefersReducedMotion = useReducedMotion()

	const handleCopy = async () => {
		try {
			// The clipboard write must stay in the same task as the click on Safari,
			// which revokes permission across an await. `ClipboardItem` with a
			// promise is the sanctioned way to hand it a value that isn't resolved
			// yet; everywhere else the plain await path is fine.
			if (sourceUrl) {
				const text = fetch(sourceUrl).then((response) => {
					if (!response.ok) throw new Error(`HTTP ${response.status}`)
					return response.text()
				})
				if (typeof ClipboardItem !== 'undefined') {
					await navigator.clipboard.write([
						new ClipboardItem({
							'text/plain': text.then(
								(value) => new Blob([value], { type: 'text/plain' }),
							),
						}),
					])
				} else {
					await navigator.clipboard.writeText(await text)
				}
			} else {
				await navigator.clipboard.writeText(markdown ?? '')
			}
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		} catch (err) {
			console.error('Failed to copy:', err)
		}
	}

	const iconMotion = prefersReducedMotion
		? {
				initial: { opacity: 0 },
				animate: { opacity: 1 },
				exit: { opacity: 0 },
			}
		: {
				initial: { opacity: 0, scale: 0.6, rotate: -45 },
				animate: { opacity: 1, scale: 1, rotate: 0 },
				exit: { opacity: 0, scale: 0.6, rotate: 45 },
			}

	const labelMotion = prefersReducedMotion
		? {
				initial: { opacity: 0 },
				animate: { opacity: 1 },
				exit: { opacity: 0 },
			}
		: {
				initial: { opacity: 0, y: 4 },
				animate: { opacity: 1, y: 0 },
				exit: { opacity: 0, y: -4 },
			}

	const transition = {
		duration: prefersReducedMotion ? 0.01 : 0.18,
		ease: easeOutQuint,
	}

	return (
		<Button
			type="button"
			onClick={handleCopy}
			variant={variant}
			size={size}
			aria-live="polite"
			className={cn('cursor-pointer', className)}
			{...rest}
		>
			<span className="relative inline-flex size-4 shrink-0 items-center justify-center">
				<AnimatePresence initial={false} mode="wait">
					<motion.span
						key={copied ? 'check' : 'clipboard'}
						{...iconMotion}
						transition={transition}
						className="absolute inset-0 inline-flex items-center justify-center"
					>
						{copied ? (
							<CheckIcon className="size-4" aria-hidden="true" />
						) : (
							<ClipboardIcon className="size-4" aria-hidden="true" />
						)}
					</motion.span>
				</AnimatePresence>
			</span>
			<span className="relative grid">
				<span
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 whitespace-nowrap"
				>
					Copy page
				</span>
				<AnimatePresence initial={false} mode="wait">
					<motion.span
						key={copied ? 'copied' : 'copy'}
						{...labelMotion}
						transition={transition}
						className="col-start-1 row-start-1 whitespace-nowrap"
					>
						{copied ? 'Copied!' : 'Copy page'}
					</motion.span>
				</AnimatePresence>
			</span>
		</Button>
	)
}
