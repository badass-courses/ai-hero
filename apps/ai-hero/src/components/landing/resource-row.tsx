'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'

import { cn } from '@coursebuilder/ui/utils/cn'

import { AnimatedArrowCircle } from './animated-arrow-circle'

import { BADGE_OUTLINE, TYPE } from './type'

const MotionLink = motion.create(Link)

type ResourceRowProps = {
	title: string
	description?: string
	href: string
	badge?: React.ReactNode
	image?: string
	typeLabel?: string
	meta?: React.ReactNode
	fallbackPlaceholder?: string
	/**
	 * The spec's `.ah-row--active`: accent border plus an accent wash. Marks
	 * the one row in a list that the reader should open first, so a numbered
	 * series doesn't need a second "start here" button competing with the
	 * page's own CTA. Compact rows only.
	 */
	active?: boolean
}

export function ResourceRow({
	title,
	description,
	href,
	badge,
	image,
	typeLabel,
	meta,
	fallbackPlaceholder,
	active,
	compact,
}: ResourceRowProps & {
	/**
	 * The spec's `.ah-row`: a bordered card with a 132×78 thumb, roughly a
	 * third the height of the full-bleed row. Sidebar pages list a dozen
	 * resources under one question, and at full-bleed height a reader sees
	 * three of them; the section stops reading as a list.
	 */
	compact?: boolean
}) {
	if (compact) {
		return (
			<CompactResourceRow
				title={title}
				description={description}
				href={href}
				badge={badge}
				image={image}
				typeLabel={typeLabel}
				meta={meta}
				fallbackPlaceholder={fallbackPlaceholder}
				active={active}
			/>
		)
	}

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
						'relative aspect-video w-full shrink-0 rounded overflow-hidden sm:w-60',
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
						<span
							className={cn(
								TYPE.badge,
								'absolute inset-0 flex items-center justify-center tracking-[0.18em] opacity-30',
							)}
						>
							{fallbackPlaceholder}
						</span>
					) : null}
				</div>
				<div className="flex flex-1 flex-col gap-2.5">
					{(typeLabel || renderedBadge) && (
						<div className="flex flex-wrap items-center gap-3">
							{renderedBadge && <span>{renderedBadge}</span>}
							{typeLabel && (
								<span
									className={cn(
										TYPE.badge,
										BADGE_OUTLINE,
										'relative z-10 inline-flex w-fit',
									)}
								>
									{typeLabel}
								</span>
							)}
						</div>
					)}
					<h3 className={cn(TYPE.subhead, '')}>
						{title}
					</h3>
					{description && (
						<div className="[&_code]:bg-muted text-balance text-sm leading-normal opacity-80 sm:text-sm [&_a]:underline [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm">
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

/**
 * `.ah-row` from the redesign spec. Hover is a border-colour change and
 * nothing else — the gradient frame belongs to the full-bleed row, which is
 * one-per-screen furniture; a dozen of them animating in a list is noise.
 */
function CompactResourceRow({
	title,
	description,
	href,
	badge,
	image,
	typeLabel,
	meta,
	fallbackPlaceholder,
	active,
}: ResourceRowProps) {
	const isExternal = /^https?:\/\//i.test(href)
	const renderedBadge =
		typeof badge === 'string' ? <DefaultBadge>{badge}</DefaultBadge> : badge

	return (
		<Link
			href={href}
			prefetch={!isExternal}
			target={isExternal ? '_blank' : undefined}
			rel={isExternal ? 'noopener noreferrer' : undefined}
			className={cn(
				'focus-visible:ring-ring group flex items-center gap-[18px] rounded-md border p-3.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2',
				active
					? // `--accent-fill`, not `--primary`: the wash has to stay gold in
						// both themes, and light-mode `--primary` is ink (DESIGN rule 7).
						'border-accent-fill/40 bg-accent-fill/[0.07] hover:border-accent-fill/60'
					: 'border-foreground/10 hover:border-foreground/20 bg-card',
			)}
		>
			<div
				className={cn(
					'relative hidden h-[78px] w-[132px] shrink-0 overflow-hidden rounded-lg sm:block',
					image ? 'bg-muted' : 'bg-stripes',
				)}
			>
				{image ? (
					<Image
						src={image}
						alt=""
						fill
						className="object-cover"
						sizes="132px"
					/>
				) : fallbackPlaceholder ? (
					<span
						className={cn(
							TYPE.badge,
							'absolute inset-0 flex items-center justify-center tracking-[0.18em] opacity-40',
						)}
					>
						{fallbackPlaceholder}
					</span>
				) : null}
			</div>
			{/* min-w-0 is required, not decorative: without it a long title blows
			    the flex track out and the arrow leaves the card. */}
			<div className="flex min-w-0 flex-col">
				{(renderedBadge || typeLabel) && (
					<div className="mb-[7px] flex items-center gap-2.5">
						{renderedBadge}
						{typeLabel && (
							<span
								className={cn(TYPE.badge, BADGE_OUTLINE, 'inline-flex w-fit')}
							>
								{typeLabel}
							</span>
						)}
					</div>
				)}
				<h3 className={cn(TYPE.subhead, 'mb-[5px] text-pretty')}>{title}</h3>
				{description && (
					<div className="text-muted-foreground line-clamp-2 text-sm leading-[1.5]">
						<ReactMarkdown components={{ p: ({ children }) => <>{children}</> }}>
							{description}
						</ReactMarkdown>
					</div>
				)}
				{meta && <div className="mt-1 text-sm">{meta}</div>}
			</div>
			<span
				aria-hidden
				className="border-foreground/15 text-muted-foreground group-hover:border-foreground/35 group-hover:text-foreground ml-auto flex size-[34px] shrink-0 items-center justify-center rounded-full border transition-colors"
			>
				<svg
					viewBox="0 0 16 16"
					fill="none"
					className="size-3.5"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M3 8h10M9 4l4 4-4 4" />
				</svg>
			</span>
		</Link>
	)
}

function DefaultBadge({ children }: { children: React.ReactNode }) {
	return (
		<span
			className={cn(
				TYPE.badge,
				'bg-foreground text-background inline-flex w-fit items-center rounded-[4px] px-[7px] py-[5px]',
			)}
		>
			{children}
		</span>
	)
}
