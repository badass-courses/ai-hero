import * as React from 'react'
import Link from 'next/link'
import { ResourceRow } from '@/components/landing/resource-row'
import type { MapTocItem } from '@/components/navigation/map-toc'
import { MapToc } from '@/components/navigation/map-toc'
import type { GoalSection } from '@/components/navigation/goal-sections-data'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import type { ResolvedItem } from '@/lib/goal-sections-query'

import { MoreWaysLink } from './more-ways-link'

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

const MONO_LABEL =
	'font-mono text-[11px] font-medium uppercase tracking-wider opacity-60'

/**
 * One list row for a resolved item — the landing `ResourceRow` (signature
 * gradient-frame hover + arrow circle). Hub-sidebar pages use lists, never
 * multi-column grids: the content column is too narrow (DESIGN / decisions.md
 * "Hub-sidebar pages use lists, not grids").
 */
function ItemRow({
	item,
	summary,
}: {
	item: ResolvedItem
	summary?: string
}) {
	return (
		<ResourceRow
			title={item.title}
			description={summary ?? item.description ?? undefined}
			href={item.href}
			image={item.thumbnailUrl ?? undefined}
			typeLabel={metaLabel(item) || undefined}
			badge={item.isVideo ? 'Video' : undefined}
			fallbackPlaceholder={item.type ? capitalize(item.type) : undefined}
		/>
	)
}

function GoalSectionBlock({ goal }: { goal: ResolvedGoalSection }) {
	const { section, items } = goal
	return (
		<section
			id={section.id}
			data-goal-section
			className="border-b scroll-mt-24 py-16 md:py-24"
		>
			{/* Text keeps the side padding; the row list bleeds full-width to the
			    container edges (DESIGN rule 1), like the landing rows. */}
			<div className="flex flex-col gap-6 md:gap-8">
				<div className="flex flex-col gap-3 px-8 sm:px-16">
					<h2 className="text-3xl font-medium leading-tight tracking-tight text-balance sm:text-4xl">
						{section.question}
					</h2>
					<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed sm:text-lg">
						{section.strapline}
					</p>
				</div>

				<div>
					{items.map((item) => (
						<ItemRow key={item.slug} item={item} />
					))}
				</div>

				{/* Footer: the signature "open" affordance for the whole topic, plus
				    the optional skill CTA. */}
				<div className="flex flex-wrap items-center gap-x-10 gap-y-4 px-8 sm:px-16">
					<MoreWaysLink href={section.moreHref} label={section.moreLabel} />
					{section.skillCta ? (
						<Link
							href={section.skillCta.href}
							className="focus-visible:ring-ring hover:bg-muted inline-flex items-center gap-2 border px-4 py-2.5 text-sm font-medium tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							{section.skillCta.label}
						</Link>
					) : null}
				</div>
			</div>
		</section>
	)
}

function WhatsNewSection({ items }: { items: ResolvedItem[] }) {
	if (items.length === 0) return null
	return (
		<section className="border-b py-16 md:py-24">
			<div className="flex flex-col gap-6 md:gap-8">
				<div className="flex flex-wrap items-end justify-between gap-4 px-8 sm:px-16">
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

				<div>
					{items.map((item) => (
						<ItemRow key={item.slug} item={item} summary={item.summary} />
					))}
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
			{/* Hero — single column (the hub content column is too narrow for a
			    two-up split). Newsletter lives at the bookend below. */}
			<section id="top" className="border-b">
				<div className="flex flex-col gap-6 px-8 py-16 sm:px-16 md:py-24">
					<p className={MONO_LABEL}>The Map</p>
					<h1 className="text-4xl font-normal leading-[1.05] tracking-tight text-balance sm:text-5xl">
						What would you like to do with AI coding?
					</h1>
					<p className="text-foreground/80 max-w-[60ch] text-lg leading-relaxed">
						Not a catalog. A map. Pick the thing you&rsquo;re trying to do, and
						follow the trail of articles, videos, and skills that get you there.
					</p>
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
