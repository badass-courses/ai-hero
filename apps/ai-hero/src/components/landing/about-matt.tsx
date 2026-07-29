import * as React from 'react'
import Image from 'next/image'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

export function AboutMatt({
	eyebrow = "Who's teaching",
	headline = "Hi, I'm Matt Pocock",
	newsletter,
	children,
}: {
	eyebrow?: string
	headline?: string
	/**
	 * The newsletter panel, rendered under the bio in the same column
	 * (`Home Page.dc.html` § MATT + NEWSLETTER). The prototype treats "who is
	 * teaching" and "get the free course" as one block rather than two
	 * sections, so the ask arrives attached to the person making it.
	 */
	newsletter?: React.ReactNode
	children: React.ReactNode
}) {
	return (
		<section className="border-border border-b">
			{/* Full bleed, portrait left (`Home Page.dc.html` § MATT). Held to a
			    centred measure the two halves read as one block but the section
			    stopped short of the container's rules, which on a page built
			    entirely of edge-to-edge bands read as a gap rather than as a
			    composition. The portrait now runs to the container's `border-x`
			    and the copy keeps the page's gutter. */}
			<div className="grid w-full grid-cols-1 items-center lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
			{/* No rule between the portrait and the copy — same call as the hero.
			    The change in ground already separates them; a hairline on top of
			    that reads as a table cell. */}
			<div className="bg-muted/30 pointer-events-none relative flex w-full select-none items-end justify-center overflow-hidden px-8 pt-8 lg:min-h-[420px] lg:px-0 lg:pt-0">
				{/* <div className="sm:bg-linear-to-r bg-linear-to-b to-background absolute inset-0 z-10 h-full w-full from-transparent via-transparent" /> */}
				{/* PARKED — the animated stripe shader behind the portrait. To restore,
				    uncomment and re-add `import { HeroStripes } from './hero-stripes-shader'`. */}
				{/*
				<HeroStripes
					className="absolute inset-0"
					speed={0.1}
					speedVariance={0.7}
					alternateDirection={1}
					stripeWidth={0.07}
					blocksPerColumn={3}
					skew={0}
					saturation={1.1}
					intensity={0.9}
					emptyBlockChance={0.1}
					chromaOffset={2}
					grain={0.25}
					grainTexture={0.1}
					vignette={0.8}
					mouseHalo={0.1}
					mouseInfluence={0.4}
				/>
				*/}
				<Image
					src="/landing/matt-pocock@2x.png"
					alt="Matt Pocock"
					priority
					sizes="(min-width: 768px) 400px, 70vw"
					width={473}
					height={520}
					// The bottom fifth dissolves into the page rather than ending on a hard
					// photographic edge. A mask, not an overlay gradient: it needs no
					// knowledge of the colour behind it, so it is right in both themes
					// for free (DESIGN rule 8).
					className="relative z-20 h-auto w-full max-w-[380px] [mask-image:linear-gradient(to_bottom,black_80%,transparent_100%)]"
				/>
			</div>
			<div className="px-[18px] pb-14 pt-8 sm:px-11 lg:py-16">
				<div className="flex flex-col gap-[18px]">
					<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						{eyebrow}
					</p>
					<h2 className={cn(TYPE.sectionByline, 'max-w-[54ch] font-sans')}>
						{headline}
					</h2>
					<div
						className={cn(
							TYPE.body,
							'flex max-w-[58ch] flex-col gap-3.5 text-pretty text-[color:var(--ah-fg-body)]',
						// See `Manifesto`: the MDX `p` carries its own bottom margin,
						// which doubled with the flex gap.
						'[&>p]:m-0!',
							'[&>p:last-child]:text-foreground [&>p:last-child]:font-medium',
						)}
					>
						{children}
					</div>
				</div>
				{newsletter ? <div className="mt-[34px]">{newsletter}</div> : null}
			</div>
			</div>
		</section>
	)
}
