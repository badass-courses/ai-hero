import * as React from 'react'
import Image from 'next/image'

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the parked shader below
import { HeroStripes } from './hero-stripes-shader'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

export function AboutMatt({
	headline = "Hi, I'm Matt Pocock",
	children,
}: {
	headline?: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border grid grid-cols-1 items-center gap-4 border-t-0! lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] lg:gap-8">
			<div className="pointer-events-none relative mx-auto flex w-full max-w-[420px] select-none items-end justify-center overflow-hidden px-8 pt-8 lg:px-0 lg:pt-0">
				{/* <div className="sm:bg-linear-to-r bg-linear-to-b to-background absolute inset-0 z-10 h-full w-full from-transparent via-transparent" /> */}
				{/* PARKED — the animated stripe shader behind the portrait. Restore
				    by uncommenting; `HeroStripes` is still imported for that. */}
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
					className="relative z-20 h-auto w-full"
				/>
			</div>
			<div className="flex flex-col gap-5 px-8 pb-12 pt-4 sm:pr-16 lg:py-16">
				<h2 className={cn(TYPE.heading, 'font-sans')}>
					{headline}
				</h2>
				<div className={cn(TYPE.body, 'flex flex-col gap-4 opacity-90')}>
					{children}
				</div>
			</div>
		</section>
	)
}
