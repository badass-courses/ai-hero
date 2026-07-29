import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { getSkillEntries } from '@/lib/skills-query'
import { log } from '@/server/logger'
import { eq, or, sql } from 'drizzle-orm'
import { ArrowRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'

import { SubscriberCount } from '../subscriber-count'
import { HeroShader } from './hero-shader'
import { HeroVideo } from './hero-video'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

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

/**
 * The hero's proof line: three numbers under a hairline, mono like every other
 * figure on the page. All three are live — list size from Kit, paid cohort
 * seats from the purchases table, published skills from the CMS. A number
 * typed into the markup is stale the week it is written, and this trio is the
 * page's evidence.
 *
 * Any stat that cannot be resolved drops out rather than falling back to a
 * figure nobody can vouch for.
 */
async function HeroStats() {
	const [skills, alumniCount] = await Promise.all([
		getSkillEntries().catch(() => []),
		getCachedCohortAlumniCount().catch(() => 0),
	])
	const alumniLabel = formatAlumniCount(alumniCount)

	const stats: { value: React.ReactNode; label: string }[] = [
		{ value: <SubscriberCount />, label: 'Developers learning' },
		...(alumniLabel
			? [{ value: alumniLabel, label: 'Trained in cohorts' }]
			: []),
		...(skills.length > 0
			? [{ value: String(skills.length), label: 'Free skills, open source' }]
			: []),
	]

	// Two columns on mobile, one row above it. The mobile rules are explicit
	// that a 3-up stat row must never become three stacked rows; at 390px a
	// third column leaves every label wrapping to three lines.
	//
	// `flex-1 basis-0` on the desktop row rather than fixed columns: a stat
	// that fails to resolve drops out, and the survivors should share the row
	// rather than leave a hole where it was.
	return (
		<dl className="border-border mt-11 grid max-w-xl grid-cols-2 gap-x-8 gap-y-6 border-t pt-[26px] sm:flex sm:gap-x-[34px]">
			{stats.map((stat) => (
				<div
					key={stat.label}
					className="flex min-w-0 flex-col gap-[7px] sm:flex-1 sm:basis-0"
				>
					<dt className="sr-only">{stat.label}</dt>
					<dd className={TYPE.stat}>{stat.value}</dd>
					<p
						className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}
						aria-hidden
					>
						{stat.label}
					</p>
				</div>
			))}
		</dl>
	)
}

export async function Hero({
	h1,
	h2,
	videoResourceId,
	variant = 'home',
	eyebrow = 'Real AI Engineering · by Matt Pocock',
	ctaLabel = 'Start the free 7-day course',
	ctaHref = '/skills/subscribe',
	secondaryCtaLabel = 'Browse the skills',
	secondaryCtaHref = '/skills',
}: {
	h1?: string
	h2?: string
	videoResourceId?: string
	/**
	 * `home` is the full masthead — eyebrow, two actions, the stat trio.
	 * `page` is the same shell carrying only words, for pages that make their
	 * own offer immediately below and would otherwise ask twice.
	 *
	 * The default is `home` because the homepage's props come from the CMS
	 * body, which cannot pass a new one until it is next edited.
	 */
	variant?: 'home' | 'page'
	eyebrow?: string
	ctaLabel?: string
	ctaHref?: string
	secondaryCtaLabel?: string
	secondaryCtaHref?: string
}) {
	const isHome = variant === 'home'
	const video = videoResourceId ? await resolveHeroVideo(videoResourceId) : null

	return (
		<header
			id="hero"
			className="border-border relative grid w-full grid-cols-1 items-stretch border-b md:min-h-[520px] md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]"
		>
			{/* 88 / 72 top and bottom, vertically centred: the copy column is the
			    taller of the two on desktop, so its padding is what sets the
			    hero's height rather than the portrait beside it. No rule between
			    the columns — the portrait fades into this ground, and a hairline
			    down the middle cuts the fade in half. */}
			<div className="flex flex-col justify-center px-[18px] py-14 sm:px-11 sm:pb-[72px] sm:pt-[88px]">
				<div>
					{isHome && eyebrow && (
						<p
							className={cn(
								TYPE.micro,
								'mb-[22px] text-[color:var(--ah-fg-label)]',
							)}
						>
							{eyebrow}
						</p>
					)}
					{h1 && (
						<h1
							className={cn(TYPE.display, 'mb-[22px] text-balance font-sans')}
						>
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
						<p
							className={cn(
								TYPE.leadHero,
								'max-w-[34ch] text-pretty opacity-70',
							)}
						>
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
				{/* One gold fill per viewport (DESIGN rule 12). The second action is
				    an outline so the free course stays the obvious first move. */}
				{isHome && (
					<div className="mt-[34px] flex flex-wrap items-center gap-2.5">
						<Link
							href={ctaHref}
							className={cn(
								TYPE.meta,
								'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex h-[46px] w-fit items-center rounded-[9px] px-5 text-[15px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
							)}
						>
							{ctaLabel}
						</Link>
						<Link
							href={secondaryCtaHref}
							className={cn(
								TYPE.meta,
								'border-foreground/20 text-foreground hover:border-foreground/40 hover:bg-secondary focus-visible:ring-ring group inline-flex h-[46px] w-fit items-center gap-2 rounded-[9px] border px-5 text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
							)}
						>
							{secondaryCtaLabel}
							<ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
						</Link>
					</div>
				)}
				{isHome && <HeroStats />}
			</div>
			<div className="relative flex min-h-80 w-full items-center justify-center">
				{video ? (
					<div className="relative aspect-video w-full">
						<HeroVideo playbackId={video.playbackId} title={video.title} />
					</div>
				) : (
					// Full-bleed: the portrait sits in the panel, not in a box inside
					// it, and the fade carries it into the copy column's ground.
					<div className="pointer-events-none absolute inset-0 flex select-none items-end justify-center overflow-hidden">
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
							className="relative z-20 h-full max-h-[560px] w-auto translate-y-px object-contain object-bottom"
							// className="relative object-contain object-bottom"
						/>
					</div>
				)}
			</div>
		</header>
	)
}
