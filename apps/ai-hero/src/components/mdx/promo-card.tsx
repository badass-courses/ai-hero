'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, BookOpenIcon, GraduationCapIcon, TerminalIcon } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

export type PromoCardVariant = 'skill' | 'course' | 'resource'

export type PromoCardProps = {
	variant: PromoCardVariant
	/** Mono uppercase kicker. Falls back to a per-variant default when omitted. */
	eyebrow?: string
	title: string
	description: string
	href: string
	ctaLabel: string
	/** skill variant only, optional — e.g. "5 min" */
	duration?: string
	/** course variant only, optional — e.g. "Next session: July 14" */
	enrollmentDate?: string
}

type VariantConfig = {
	defaultEyebrow: string
	/** whole-card surface — tinted border + bg + hover, light and dark */
	surface: string
	/** eyebrow text color */
	eyebrowColor: string
	/** icon chip surface + icon color */
	chip: string
	/** solid CTA button */
	button: string
	icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}

/**
 * Styled to match the in-article CTA family (`SkillsCta` /
 * `SkillsNewsletterCta`): rounded-xl tinted card, whole-card link, mono
 * eyebrow, solid rounded-lg button. In-article CTAs are the documented
 * exception to DESIGN.md rule 12 (square UI). Each variant keeps a distinct
 * hue + icon so the three cards never read as identical boxes.
 */
const VARIANTS: Record<PromoCardVariant, VariantConfig> = {
	skill: {
		defaultEyebrow: 'Related Skill',
		surface:
			'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 dark:border-primary/30 dark:bg-primary/5 dark:hover:bg-primary/10',
		eyebrowColor: 'text-blue-500 dark:text-primary',
		chip: 'bg-blue-500/10 text-blue-500 dark:bg-primary/10 dark:text-primary',
		button:
			'bg-blue-500 text-white group-hover:bg-blue-500/90 dark:bg-primary dark:text-primary-foreground dark:group-hover:bg-primary/90',
		icon: TerminalIcon,
	},
	course: {
		defaultEyebrow: 'Course',
		surface: 'border-primary/30 bg-primary/5 hover:bg-primary/10',
		eyebrowColor: 'text-primary',
		chip: 'bg-primary/10 text-primary',
		button:
			'bg-primary text-primary-foreground group-hover:bg-primary/90',
		icon: GraduationCapIcon,
	},
	resource: {
		defaultEyebrow: 'Free Resource',
		surface: 'border-border bg-muted/40 hover:bg-muted/70',
		eyebrowColor: 'text-foreground/60',
		chip: 'bg-muted text-foreground',
		button: 'bg-foreground text-background group-hover:bg-foreground/90',
		icon: BookOpenIcon,
	},
}

export function PromoCard({
	variant,
	eyebrow,
	title,
	description,
	href,
	ctaLabel,
	duration,
	enrollmentDate,
}: PromoCardProps) {
	const config = VARIANTS[variant]
	const Icon = config.icon
	const resolvedEyebrow = eyebrow ?? config.defaultEyebrow
	const meta = variant === 'skill' ? duration : enrollmentDate

	return (
		<Link
			href={href}
			aria-label={`${resolvedEyebrow}: ${title}`}
			className={cn(
				'not-prose group focus-visible:ring-ring focus-visible:ring-offset-background my-10 flex flex-col items-start gap-5 rounded-xl border p-6 no-underline transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:flex-row sm:items-center sm:gap-8 sm:p-8',
				config.surface,
			)}
		>
			<div
				aria-hidden
				className={cn(
					'flex size-12 shrink-0 items-center justify-center rounded-lg',
					config.chip,
				)}
			>
				<Icon className="size-6 shrink-0" aria-hidden />
			</div>
			<div className="flex flex-1 flex-col gap-2">
				<span
					className={cn(
						'font-mono text-[11px] font-medium uppercase tracking-wider',
						config.eyebrowColor,
					)}
				>
					{resolvedEyebrow}
					{meta ? (
						<span className="text-foreground/60 normal-case tracking-wide">
							{' '}
							· {meta}
						</span>
					) : null}
				</span>
				<h3 className="text-foreground text-balance font-sans text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
					{title}
				</h3>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{description}
				</p>
			</div>
			<span
				className={cn(
					'inline-flex shrink-0 items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition',
					config.button,
				)}
			>
				{ctaLabel}
				<ArrowRight
					className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
					aria-hidden="true"
				/>
			</span>
		</Link>
	)
}
