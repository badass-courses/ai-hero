'use client'

import * as React from 'react'
import Link from 'next/link'
import { AnimatedArrowCircle } from '@/components/landing/animated-arrow-circle'
import { motion } from 'framer-motion'

const MotionLink = motion.create(Link)

export type ChangelogItem = {
	id: string
	href: string
	title: string
	description?: string
	publishedAt: string | null
}

export function ChangelogList({ items }: { items: ChangelogItem[] }) {
	if (items.length === 0) {
		return (
			<div className="border-border border-t px-8 py-16 sm:px-16 sm:py-20">
				<p className="font-mono text-xs uppercase tracking-wider opacity-60">
					No skill changelog entries have been published yet.
				</p>
			</div>
		)
	}

	return (
		<ol className="border-border bg-border flex flex-col gap-px border-t">
			{items.map((item) => (
				<li key={item.id} className="bg-background">
					<ChangelogRow {...item} />
				</li>
			))}
		</ol>
	)
}

function ChangelogRow({
	href,
	title,
	description,
	publishedAt,
}: ChangelogItem) {
	const isExternal = /^https?:\/\//i.test(href)

	return (
		<MotionLink
			href={href}
			prefetch={!isExternal}
			target={isExternal ? '_blank' : undefined}
			rel={isExternal ? 'noopener noreferrer' : undefined}
			initial="initial"
			whileHover="hover"
			animate="initial"
			className="hover:bg-muted/40 group relative flex flex-col gap-5 px-5 py-6 transition-colors sm:flex-row sm:items-start sm:gap-12 sm:px-14 sm:py-8"
		>
			<div className="flex shrink-0 flex-col gap-2 sm:w-44">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Skill update
				</span>
				{publishedAt && (
					<span className="font-mono text-xs uppercase tracking-wider opacity-80">
						{publishedAt}
					</span>
				)}
			</div>
			<div className="flex flex-1 flex-col gap-2.5">
				<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
					{title}
				</h3>
				{description && (
					<p className="text-balance text-sm leading-relaxed opacity-80 sm:text-base">
						{description}
					</p>
				)}
			</div>
			<div className="hidden sm:block">
				<AnimatedArrowCircle />
			</div>
		</MotionLink>
	)
}
