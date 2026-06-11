'use client'

import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CheckIcon, ClipboardIcon } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import type { ButtonProps } from '@coursebuilder/ui/primitives/button'
import { cn } from '@coursebuilder/ui/utils/cn'

const easeOutQuint = [0.22, 1, 0.36, 1] as const

export function CopyPageButton({
	markdown,
	className,
	variant = 'outline',
	size = 'default',
	...rest
}: {
	markdown: string
} & ButtonProps) {
	const [copied, setCopied] = useState(false)
	const prefersReducedMotion = useReducedMotion()

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(markdown)
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
