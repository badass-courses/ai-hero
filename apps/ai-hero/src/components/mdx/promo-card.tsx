'use client'

import * as React from 'react'
import Link from 'next/link'
import { AnimatedArrowCircle } from '@/components/landing/animated-arrow-circle'
import { motion } from 'framer-motion'
import { BookOpenIcon, GraduationCapIcon, TerminalIcon } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

const MotionLink = motion.create(Link)

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
	/** whole-card surface — distinct per variant to defeat "box blindness" */
	surface: string
	/** icon rail surface + icon color */
	rail: string
	icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}

/**
 * Each variant gets a distinct surface + icon rail treatment (not just a
 * different glyph) so the three cards never read as identical boxes. All
 * treatments are token-driven per DESIGN.md; no raw hex, no side-stripe borders.
 */
const VARIANTS: Record<PromoCardVariant, VariantConfig> = {
	skill: {
		defaultEyebrow: 'Related Skill',
		surface: 'bg-card',
		rail: 'bg-stripes text-primary',
		icon: TerminalIcon,
	},
	course: {
		defaultEyebrow: 'Course',
		surface: 'bg-primary/5',
		rail: 'bg-primary/10 text-primary',
		icon: GraduationCapIcon,
	},
	resource: {
		defaultEyebrow: 'Free Resource',
		surface: 'bg-muted',
		rail: 'bg-background text-foreground',
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
		<MotionLink
			href={href}
			initial="initial"
			whileHover="hover"
			animate="initial"
			aria-label={`${resolvedEyebrow}: ${title}`}
			className={cn(
				'not-prose group focus-visible:ring-ring focus-visible:ring-offset-background relative my-8 flex items-stretch gap-0 border no-underline transition-colors hover:brightness-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
				config.surface,
			)}
		>
			<div
				aria-hidden
				className={cn(
					'flex shrink-0 items-center justify-center overflow-hidden border-r px-5 py-4',
					config.rail,
				)}
			>
				<Icon className="size-5 shrink-0" aria-hidden />
			</div>
			<div className="flex flex-1 flex-col gap-2 p-5 sm:p-6">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider opacity-80">
					{resolvedEyebrow}
				</span>
				<h3 className="text-foreground text-balance font-sans text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
					{title}
				</h3>
				{meta ? (
					<span className="text-foreground/60 font-mono text-[11px] font-medium tracking-wide">
						{meta}
					</span>
				) : null}
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{description}
				</p>
				<span className="text-foreground mt-2 inline-flex items-center gap-3 text-sm font-medium">
					{ctaLabel}
					<AnimatedArrowCircle />
				</span>
			</div>
		</MotionLink>
	)
}
