import * as React from 'react'
import Image from 'next/image'

import { HeroStripes } from './hero-stripes-shader'

export function AboutMatt({
	headline = "Hi, I'm Matt Pocock",
	children,
}: {
	headline?: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
			<div className="pointer-events-none relative mx-auto flex aspect-square w-full max-w-[600px] select-none items-end justify-center overflow-hidden">
				{/* <div className="sm:bg-linear-to-r bg-linear-to-b to-background absolute inset-0 z-10 h-full w-full from-transparent via-transparent" /> */}
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
				<Image
					src="/landing/matt-pocock@2x.png"
					alt="Matt Pocock"
					priority
					sizes="(min-width: 768px) 400px, 70vw"
					width={473}
					height={520}
					className="relative z-20 h-auto w-full max-w-sm"
				/>
			</div>
			<div className="flex flex-col gap-6 px-8 py-12 sm:pr-16 md:py-24">
				<h2 className="font-sans text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
					{headline}
				</h2>
				<div className="flex flex-col gap-4 text-base leading-relaxed opacity-90 sm:text-lg">
					{children}
				</div>
			</div>
		</section>
	)
}
