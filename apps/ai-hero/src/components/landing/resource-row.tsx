'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'

import { cn } from '@coursebuilder/ui/utils/cn'

import { AnimatedArrowCircle } from './animated-arrow-circle'

const MotionLink = motion.create(Link)

export function ResourceRow({
	title,
	description,
	href,
	badge,
	image,
	typeLabel,
	meta,
	fallbackPlaceholder,
}: {
	title: string
	description?: string
	href: string
	badge?: React.ReactNode
	image?: string
	typeLabel?: string
	meta?: React.ReactNode
	fallbackPlaceholder?: string
}) {
	const isExternal = /^https?:\/\//i.test(href)
	const renderedBadge =
		typeof badge === 'string' ? <DefaultBadge>{badge}</DefaultBadge> : badge

	return (
		<MotionLink
			href={href}
			prefetch={!isExternal}
			target={isExternal ? '_blank' : undefined}
			rel={isExternal ? 'noopener noreferrer' : undefined}
			initial="initial"
			whileHover="hover"
			animate="initial"
			className="border-border group relative -mt-px block border-y"
		>
			<motion.div
				aria-hidden
				className="animate-resource-gradient pointer-events-none absolute -inset-y-px inset-x-0"
				style={{
					backgroundImage:
						'linear-gradient(90deg, oklch(0.92 0.05 30), oklch(0.74 0.18 50), oklch(0.82 0.12 350), oklch(0.50 0.20 260), oklch(0.85 0.10 5), oklch(0.92 0.07 145), oklch(0.74 0.18 50), oklch(0.88 0.18 95), oklch(0.62 0.22 25), oklch(0.74 0.18 45), oklch(0.82 0.12 350), oklch(0.92 0.05 30))',
					backgroundSize: '200% 200%',
				}}
				variants={{
					initial: { opacity: 0 },
					hover: { opacity: 1 },
				}}
				transition={{ duration: 0.4, ease: [0.65, 0, 0.35, 1] }}
			/>
			<motion.div
				aria-hidden
				className="bg-background pointer-events-none absolute"
				variants={{
					initial: { top: 0, right: 0, bottom: 0, left: 0 },
					hover: { top: 5, right: 5, bottom: 5, left: 5 },
				}}
				transition={{ duration: 0.4, ease: [0.65, 0, 0.35, 1] }}
			/>
			<div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-8 sm:px-14 sm:py-10">
				<div
					className={cn(
						'relative aspect-video w-full shrink-0 overflow-hidden sm:w-60',
						image ? 'bg-muted' : 'bg-stripes',
					)}
				>
					{image ? (
						<Image
							src={image}
							alt={title}
							fill
							className="object-cover transition-transform duration-500 ease-in-out group-hover:scale-105"
							sizes="(min-width: 640px) 240px, 100vw"
						/>
					) : fallbackPlaceholder ? (
						<span className="absolute inset-0 flex items-center justify-center font-mono text-xs font-semibold uppercase tracking-widest opacity-30">
							{fallbackPlaceholder}
						</span>
					) : null}
				</div>
				<div className="flex flex-1 flex-col gap-2.5">
					{(typeLabel || renderedBadge) && (
						<div className="flex flex-wrap items-center gap-3">
							{renderedBadge && <span>{renderedBadge}</span>}
							{typeLabel && (
								<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
									{typeLabel}
								</span>
							)}
						</div>
					)}
					<h3 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
						{title}
					</h3>
					{description && (
						<div className="[&_code]:bg-muted text-balance text-sm leading-relaxed opacity-80 sm:text-base [&_a]:underline [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm">
							<ReactMarkdown
								components={{
									p: ({ children }) => <>{children}</>,
								}}
							>
								{description}
							</ReactMarkdown>
						</div>
					)}
					{meta && <div className="mt-1 text-sm sm:text-base">{meta}</div>}
				</div>
				<AnimatedArrowCircle />
			</div>
		</MotionLink>
	)
}

function DefaultBadge({ children }: { children: React.ReactNode }) {
	return (
		<span className="bg-foreground text-background inline-flex w-fit items-center rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider">
			{children}
		</span>
	)
}
