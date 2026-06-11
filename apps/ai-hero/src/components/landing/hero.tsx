import * as React from 'react'
import Image from 'next/image'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { log } from '@/server/logger'
import { eq, or, sql } from 'drizzle-orm'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'

import { HeroShader } from './hero-shader'
import { HeroVideo } from './hero-video'

type HeroVideoData = { playbackId: string; title?: string }

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

async function resolveHeroVideo(
	videoResourceId: string,
): Promise<HeroVideoData | null> {
	try {
		const found = await db.query.contentResource.findFirst({
			where: or(
				eq(
					sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
					videoResourceId,
				),
				eq(contentResource.id, videoResourceId),
			),
			with: { resources: { with: { resource: true } } },
		})
		if (!found) {
			await log.warn('landing.hero.video.missing', { videoResourceId })
			return null
		}

		if (found.type === 'videoResource') {
			const playbackId = readString(found.fields, 'muxPlaybackId')
			return playbackId ? { playbackId } : null
		}

		const videoResource = found.resources?.find(
			(r) => r.resource?.type === 'videoResource',
		)?.resource
		if (!videoResource) return null
		const playbackId = readString(videoResource.fields, 'muxPlaybackId')
		if (!playbackId) return null
		return { playbackId, title: readString(found.fields, 'title') }
	} catch (error) {
		await log.error('landing.hero.video.lookup.error', {
			videoResourceId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

export async function Hero({
	h1,
	h2,
	videoResourceId,
}: {
	h1?: string
	h2?: string
	videoResourceId?: string
}) {
	const video = videoResourceId ? await resolveHeroVideo(videoResourceId) : null

	return (
		<header
			id="hero"
			className="border-border min-h-104 relative grid w-full grid-cols-1 items-stretch border-b md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
		>
			<div className="flex flex-col justify-center gap-4 px-8 py-10 sm:px-16 sm:py-20 lg:pl-32">
				{h1 && (
					<h1 className="text-nowrap font-sans text-5xl font-normal leading-[1.05] tracking-tight lg:text-6xl dark:text-white">
						<ReactMarkdown
							rehypePlugins={[rehypeRaw]}
							components={{
								p: ({ children }) => <>{children}</>,
								strong: ({ children }) => (
									<span className="font-bold">{children}</span>
								),
							}}
						>
							{h1}
						</ReactMarkdown>
					</h1>
				)}
				{h2 && (
					<p className="text-2xl font-light leading-tight tracking-tight opacity-70">
						<ReactMarkdown
							components={{
								p: ({ children }) => <>{children}</>,
							}}
						>
							{h2}
						</ReactMarkdown>
					</p>
				)}
			</div>
			<div className="relative flex h-full w-full items-center justify-center">
				{video ? (
					<div className="relative aspect-video w-full">
						<HeroVideo playbackId={video.playbackId} title={video.title} />
					</div>
				) : (
					<div className="pointer-events-none relative flex aspect-square w-full max-w-[723px] select-none items-end justify-center overflow-hidden pt-10 lg:aspect-[4/3]">
						<div className="sm:bg-linear-to-l bg-linear-to-t to-background absolute inset-0 z-10 h-full w-full from-transparent via-transparent" />
						<HeroShader
							className="absolute inset-0"
							speed={0.2}
							frequency={7.0}
							displacement={0.018}
							displacementFreq={4.5}
							mouseFollow={0.03}
							mouseInfluence={0.55}
							flowY={0.2}
							flowX={0.2}
							intensity={1.0}
							saturation={1.25}
							sharpness={0.7}
							grain={0.1}
							grainTexture={0.3}
							grainScale={0.5}
							chromaOffset={13.0}
							vignette={0}
							mouseHalo={0.15}
							posterize={0.1}
							colorDrift={0.05}
							seed={10}
						/>
						{/* <HeroStripes
							alternateDirection={0.5}
							stripeWidth={0.12}
							blocksPerColumn={3.5}
							emptyBlockChance={0.2}
							colors={STRIPE_PALETTES.brand}
							background={[-0.05, -0.05, -0.06]}
							saturation={1.25}
							intensity={1.0}
							grain={0.4}
							grainTexture={0.35}
							grainScale={1.0}
							chromaOffset={1.5}
							vignette={0.2}
							mouseFollow={0.035}
							mouseInfluence={0.4}
							mouseHalo={0.1}
							className="absolute inset-0"
						/> */}
						<Image
							priority
							src="/landing/matt-pocock-left@2x.png"
							alt="Matt Pocock"
							// fill
							width={349}
							height={374}
							sizes="(min-width: 768px) 50vw, 100vw"
							className="relative z-20 translate-y-px"
							// className="relative object-contain object-bottom"
						/>
					</div>
				)}
			</div>
		</header>
	)
}
