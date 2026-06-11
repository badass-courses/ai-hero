'use client'

import * as React from 'react'
import Link from 'next/link'
import { AnimatedArrowCircle } from '@/components/landing/animated-arrow-circle'
import { motion } from 'framer-motion'

const MotionLink = motion.create(Link)

type GuideItem = {
	label: string
	title: string
	href: string
}

export function GuideGrid({ items }: { items: GuideItem[] }) {
	return (
		<div className="border-border bg-border grid grid-cols-1 gap-px border-y md:grid-cols-3">
			{items.map((item) => (
				<GuideCard key={item.href} {...item} />
			))}
		</div>
	)
}

function GuideCard({ label, title, href }: GuideItem) {
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
			className="bg-background hover:bg-muted/40 group relative flex min-h-56 flex-col justify-between gap-12 px-8 py-10 transition-colors sm:px-10 sm:py-12"
		>
			<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
				{label}
			</span>
			<div className="flex items-end justify-between gap-6">
				<h3 className="text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-[1.625rem]">
					{title}
				</h3>
				<AnimatedArrowCircle />
			</div>
		</MotionLink>
	)
}
