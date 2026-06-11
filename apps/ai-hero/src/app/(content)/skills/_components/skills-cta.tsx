import * as React from 'react'
import Link from 'next/link'
import { ThemeImage } from '@/components/cld-image'
import { ArrowRightIcon } from 'lucide-react'

const SKILLS_CTA_IMAGE = {
	dark: 'https://res.cloudinary.com/total-typescript/image/upload/v1777381174/skills-newsletter-dark.png',
	light:
		'https://res.cloudinary.com/total-typescript/image/upload/v1777381174/skills-newsletter-light.png',
}

export function SkillsCta({
	heading = 'Browse the AI Hero skill set',
	subtitle = 'A practical skill system for engineers using AI without giving up their standards.',
	cta = 'Browse the skill set',
}: {
	heading?: string
	subtitle?: string
	cta?: string
}) {
	return (
		<Link
			href="/skills"
			className="not-prose dark:border-primary/30 dark:bg-primary/5 dark:hover:bg-primary/10 group my-10 flex flex-col items-start gap-5 rounded-xl border border-blue-500/30 bg-blue-500/5 p-6 no-underline transition hover:bg-blue-500/10 sm:flex-row sm:items-center sm:gap-8 sm:p-8"
		>
			<div className="aspect-[146/191] w-28 shrink-0 sm:w-32">
				<ThemeImage
					urls={SKILLS_CTA_IMAGE}
					width={146}
					height={191}
					alt=""
					aria-hidden
					className="my-0 h-full w-full"
				/>
			</div>
			<div className="flex flex-1 flex-col gap-2">
				<span className="dark:text-primary font-mono text-[11px] font-medium uppercase tracking-wider text-blue-500">
					AI Hero · Skill System
				</span>
				<h3 className="text-foreground text-balance font-sans text-2xl font-semibold leading-tight tracking-tight sm:text-[1.625rem]">
					{heading}
				</h3>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{subtitle}
				</p>
			</div>
			<span className="dark:bg-primary dark:text-primary-foreground dark:group-hover:bg-primary/90 inline-flex shrink-0 items-center gap-2 rounded-lg bg-blue-500 px-5 py-3 text-sm font-semibold text-white transition group-hover:bg-blue-500/90">
				{cta}
				<ArrowRightIcon
					className="size-4 transition-transform group-hover:translate-x-1"
					aria-hidden
				/>
			</span>
		</Link>
	)
}
