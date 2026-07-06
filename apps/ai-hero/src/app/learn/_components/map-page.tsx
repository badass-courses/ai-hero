import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { ResourceGrid } from '@/components/landing/resource'
import type { MapTocItem } from '@/components/navigation/map-toc'
import { MapToc } from '@/components/navigation/map-toc'
import type { GoalSection } from '@/components/navigation/goal-sections-data'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import type { ResolvedItem } from '@/lib/goal-sections-query'
import { ArrowUp, Play } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * MapPage — presentational composition for the `/learn` Map page (W3, spec §3).
 *
 * Pure server component: every piece of data (resolved goal-section items,
 * What's New posts) is fetched up front in `page.tsx` and passed as props. The
 * only client interactivity lives inside `MapToc` (active-section observer +
 * the search-only Ask AIHero bot) and `PrimaryNewsletterCta`.
 *
 * NO breadcrumbs (deliberate — the Map is a wayfinding layer, not a hierarchy).
 * NO section background tints — typography and whitespace differentiate goals.
 */

/** A goal section with its item refs already resolved to real posts (config order, unresolved dropped). */
export interface ResolvedGoalSection {
	section: GoalSection
	items: ResolvedItem[]
}

export interface MapPageProps {
	/** Goal sections with resolved item cards, in config order. */
	goalSections: ResolvedGoalSection[]
	/** Most-recent published posts for the What's New featured row. */
	whatsNew: ResolvedItem[]
	/** Flat anchor-TOC entries (one per goal section). */
	tocItems: MapTocItem[]
	/** Curated "Try asking" prompts for the bot. */
	suggestions: string[]
	/** Every goal-section item slug — the bot's Map-linked boost set. */
	boostSlugs: string[]
}

function capitalize(s: string): string {
	if (!s) return s
	return s[0]!.toUpperCase() + s.slice(1)
}

/** "Article · 12 min read" style meta from a resolved item. */
function metaLabel(item: ResolvedItem): string {
	const parts: string[] = []
	if (item.type) parts.push(capitalize(item.type))
	if (item.durationLabel) parts.push(item.durationLabel)
	return parts.join(' · ')
}

function formatDate(value?: Date | null): string | null {
	if (!value) return null
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) return null
	try {
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
		}).format(date)
	} catch {
		return null
	}
}

const MONO_LABEL =
	'font-mono text-[11px] font-medium uppercase tracking-wider opacity-60'

function VideoBadge() {
	return (
		<span className="bg-background/90 text-foreground absolute left-3 top-3 inline-flex items-center gap-1 px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-wider">
			<Play aria-hidden className="size-3 shrink-0" />
			Video
		</span>
	)
}

/** Goal-section item card. Thumbnail + type/duration + title + truncated description. */
function GoalItemCard({ item }: { item: ResolvedItem }) {
	return (
		<Link
			href={item.href}
			className="bg-background group flex h-full flex-col overflow-hidden transition hover:brightness-110"
		>
			<div
				className={cn(
					'relative aspect-video w-full overflow-hidden',
					item.thumbnailUrl ? 'bg-muted' : 'bg-stripes',
				)}
			>
				{item.thumbnailUrl ? (
					<Image
						src={item.thumbnailUrl}
						alt={item.title}
						fill
						className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
						sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
					/>
				) : null}
				{item.isVideo ? <VideoBadge /> : null}
			</div>
			<div className="flex flex-1 flex-col gap-2 px-7 py-6">
				{metaLabel(item) ? <p className={MONO_LABEL}>{metaLabel(item)}</p> : null}
				<h3 className="text-lg font-semibold leading-snug tracking-tight text-balance">
					{item.title}
				</h3>
				{item.description ? (
					<p className="text-foreground/70 line-clamp-3 text-sm leading-relaxed">
						{item.description}
					</p>
				) : null}
			</div>
		</Link>
	)
}

/** Trailing "More ways to X →" card — a plain grid cell so ResourceGrid's filler math stays correct. */
function MoreWaysCard({ href, label }: { href: string; label: string }) {
	return (
		<Link
			href={href}
			className="bg-background hover:bg-muted group flex h-full min-h-[12rem] flex-col justify-between gap-6 px-7 py-6 transition-colors"
		>
			<span className={MONO_LABEL}>More</span>
			<span className="text-foreground group-hover:text-foreground inline-flex items-center gap-2 text-lg font-semibold leading-snug tracking-tight">
				{label}
			</span>
		</Link>
	)
}

function GoalSectionBlock({ goal }: { goal: ResolvedGoalSection }) {
	const { section, items } = goal
	return (
		<section id={section.id} data-goal-section className="border-b scroll-mt-24">
			<div className="flex flex-col gap-6 px-8 py-16 sm:px-16 md:gap-8 md:py-24">
				<div className="flex flex-col gap-3">
					<h2 className="text-3xl font-medium leading-tight tracking-tight text-balance sm:text-4xl">
						{section.question}
					</h2>
					<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed sm:text-lg">
						{section.strapline}
					</p>
				</div>

				<ResourceGrid>
					{items.map((item) => (
						<GoalItemCard key={item.slug} item={item} />
					))}
					<MoreWaysCard
						key="more-ways"
						href={section.moreHref}
						label={section.moreLabel}
					/>
				</ResourceGrid>

				{section.skillCta ? (
					<div>
						<Link
							href={section.skillCta.href}
							className="focus-visible:ring-ring hover:bg-muted inline-flex items-center gap-2 border px-4 py-2.5 text-sm font-medium tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							{section.skillCta.label}
						</Link>
					</div>
				) : null}

				<div>
					<a
						href="#top"
						className="text-foreground/60 hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 text-sm tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2"
					>
						<ArrowUp aria-hidden className="size-3.5 shrink-0" />
						top
					</a>
				</div>
			</div>
		</section>
	)
}

/** Featured What's New card — larger thumbnail + summary. */
function FeaturedWhatsNewCard({ item }: { item: ResolvedItem }) {
	const date = formatDate(item.publishedAt)
	return (
		<Link
			href={item.href}
			className="bg-background group flex h-full flex-col overflow-hidden transition hover:brightness-110"
		>
			<div
				className={cn(
					'relative aspect-video w-full overflow-hidden',
					item.thumbnailUrl ? 'bg-muted' : 'bg-stripes',
				)}
			>
				{item.thumbnailUrl ? (
					<Image
						src={item.thumbnailUrl}
						alt={item.title}
						fill
						className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
						sizes="(min-width: 768px) 58vw, 100vw"
					/>
				) : null}
				{item.isVideo ? <VideoBadge /> : null}
			</div>
			<div className="flex flex-1 flex-col gap-3 px-8 py-8">
				<p className={MONO_LABEL}>
					{[metaLabel(item), date].filter(Boolean).join(' · ')}
				</p>
				<h3 className="text-2xl font-semibold leading-tight tracking-tight text-balance sm:text-3xl">
					{item.title}
				</h3>
				{item.summary ? (
					<p className="text-foreground/70 max-w-[65ch] text-base leading-relaxed">
						{item.summary}
					</p>
				) : null}
			</div>
		</Link>
	)
}

/** Compact What's New card — meta + title, no thumbnail. */
function CompactWhatsNewCard({ item }: { item: ResolvedItem }) {
	const date = formatDate(item.publishedAt)
	return (
		<Link
			href={item.href}
			className="bg-background hover:bg-muted group flex flex-1 flex-col justify-center gap-2 px-8 py-6 transition-colors"
		>
			<p className={MONO_LABEL}>
				{[metaLabel(item), date].filter(Boolean).join(' · ')}
			</p>
			<h3 className="text-lg font-semibold leading-snug tracking-tight text-balance">
				{item.title}
			</h3>
		</Link>
	)
}

function WhatsNewSection({ items }: { items: ResolvedItem[] }) {
	if (items.length === 0) return null
	const [featured, ...rest] = items
	const compact = rest.slice(0, 2)
	return (
		<section className="border-b">
			<div className="flex flex-col gap-6 px-8 py-16 sm:px-16 md:gap-8 md:py-24">
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div className="flex flex-col gap-2">
						<p className={MONO_LABEL}>What&rsquo;s New</p>
						<h2 className="text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
							Fresh from the blog
						</h2>
					</div>
					<Link
						href="/posts"
						className="text-foreground/70 hover:text-foreground focus-visible:ring-ring text-sm font-medium tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2"
					>
						See all posts →
					</Link>
				</div>

				<div className="border-border bg-border grid gap-px border-y md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
					{featured ? <FeaturedWhatsNewCard item={featured} /> : null}
					{compact.length > 0 ? (
						<div className="bg-border grid gap-px">
							{compact.map((item) => (
								<CompactWhatsNewCard key={item.slug} item={item} />
							))}
						</div>
					) : null}
				</div>
			</div>
		</section>
	)
}

export function MapPage({
	goalSections,
	whatsNew,
	tocItems,
	suggestions,
	boostSlugs,
}: MapPageProps) {
	return (
		<div>
			{/* Hero */}
			<section id="top" className="border-b">
				<div className="grid gap-8 px-8 py-16 sm:px-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center md:gap-16 md:py-24">
					<div className="flex flex-col gap-6">
						<p className={MONO_LABEL}>The Map</p>
						<h1 className="text-4xl font-normal leading-[1.05] tracking-tight text-balance sm:text-5xl lg:text-6xl">
							What would you like to do with AI coding?
						</h1>
						<p className="text-foreground/80 max-w-[55ch] text-base leading-relaxed sm:text-lg">
							Not a catalog. A map. Pick the thing you&rsquo;re trying to do,
							and follow the trail of articles, videos, and skills that get you
							there.
						</p>
					</div>
					<div className="w-full">
						<PrimaryNewsletterCta
							titleElement="h1"
							trackProps={{ event: 'learn_hero_newsletter' }}
						/>
					</div>
				</div>
			</section>

			{/* TOC + Ask AIHero bot (bot open state + render lives in MapToc) */}
			<MapToc
				items={tocItems}
				suggestions={suggestions}
				boostSlugs={boostSlugs}
			/>

			{/* Goal sections */}
			{goalSections.map((goal) => (
				<GoalSectionBlock key={goal.section.id} goal={goal} />
			))}

			{/* What's New featured row */}
			<WhatsNewSection items={whatsNew} />

			{/* Bookend CTA */}
			<section>
				<div className="px-8 py-16 sm:px-16 md:py-24">
					<PrimaryNewsletterCta
						titleElement="h2"
						trackProps={{ event: 'learn_bookend_newsletter' }}
					/>
				</div>
			</section>
		</div>
	)
}
