'use client'

import * as React from 'react'
import Link from 'next/link'
import { AnimatedArrowCircle } from '@/components/landing/animated-arrow-circle'
import { motion } from 'framer-motion'

const MotionLink = motion.create(Link)

/**
 * "More ways to X" footer link for a Map goal section. Mirrors the homepage
 * `ResourceRow` affordance: a plain editorial link whose trailing
 * `AnimatedArrowCircle` (the site's signature "open" gesture) draws itself on
 * hover via framer variant propagation from this `MotionLink`.
 *
 * Lives OUTSIDE the goal `ResourceGrid` on purpose — folding it into the grid
 * left orphan cells + empty filler rows whenever the item count wasn't a clean
 * multiple of the column count. As a footer link the grid stays fully packed.
 *
 * `label` may carry a trailing " →" (the config authors it that way); it is
 * stripped here so the arrow circle is the only arrow.
 */
export function MoreWaysLink({ href, label }: { href: string; label: string }) {
	const text = label.replace(/\s*→\s*$/, '')
	return (
		<MotionLink
			href={href}
			initial="initial"
			whileHover="hover"
			animate="initial"
			className="focus-visible:ring-ring group inline-flex items-center gap-4 tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
		>
			<span className="text-lg font-semibold leading-snug tracking-tight sm:text-xl">
				{text}
			</span>
			<AnimatedArrowCircle />
		</MotionLink>
	)
}
