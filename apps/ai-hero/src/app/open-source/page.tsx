import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { HubLayout } from '@/components/navigation/hub-layout'
import { getRepoStarCount } from '@/lib/github-stars-query'
import {
	OPEN_SOURCE_HERO,
	OPEN_SOURCE_PROJECTS,
	type OpenSourceProject,
} from '@/lib/open-source-content'
import { ArrowUpRight, Star, Youtube } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

export const metadata: Metadata = {
	title: 'Open Source | AI Hero',
	description: 'Open source AI tools and projects from AI Hero.',
}

/**
 * The open source projects behind AI Hero. Replaces the `/tools` placeholder:
 * "Tools" promised a category with nothing to fill it, and collided with the
 * `/what-are-tools` post about LLM tool calling.
 *
 * Star counts are consolidated here and passed down as props, the same pattern
 * `SkillsHero` uses, so a repo is looked up once per render.
 */
export default async function OpenSourcePage() {
	// `repoOwner`/`repoName` are optional now — a row without them is not a
	// repository and has nothing to count — so the guard is on the pair being
	// present, not on `showStars` alone.
	const starTargets = OPEN_SOURCE_PROJECTS.filter(
		(p): p is OpenSourceProject & { repoOwner: string; repoName: string } =>
			Boolean(p.showStars && p.repoOwner && p.repoName),
	)
	const starEntries = await Promise.all(
		starTargets.map(
			async (p): Promise<[string, Awaited<ReturnType<typeof getRepoStarCount>>]> => [
				`${p.repoOwner}/${p.repoName}`,
				await getRepoStarCount(p.repoOwner, p.repoName),
			],
		),
	)
	const stars = new Map(starEntries)

	return (
		<LayoutClient withContainer withFooter={false}>
			<HubLayout>
				<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))]">
					<section className="border-b">
						{/* Was a hand-rolled hero: a `font-normal` h1 where every other
						    page `h1` is `TYPE.title` at 700, plus its own eyebrow and lead
						    sizes. Tokens now, per DESIGN rule 10. `pb-11 pt-12` matches
						    the /skills hero instead of `py-16 md:py-24`. */}
						<div className="flex flex-col gap-6 px-[18px] pb-11 pt-12 sm:px-11">
							<p className={TYPE.eyebrow}>{OPEN_SOURCE_HERO.eyebrow}</p>
							<h1 className={cn(TYPE.title, 'text-balance')}>
								{OPEN_SOURCE_HERO.title}
							</h1>
							<p className={cn(TYPE.lead, 'text-muted-foreground max-w-[65ch]')}>
								{OPEN_SOURCE_HERO.description}
							</p>
						</div>
					</section>

					{/* Hairline rows: the line layer is the list's own bg-border showing
					    through gap-px, never a border per cell (DESIGN.md rule 2). No
					    trailing border-b, so the last row does not double against the
					    footer rule. */}
					<section aria-label="Open source projects">
						<ul className="bg-border flex flex-col gap-px">
							{OPEN_SOURCE_PROJECTS.map((project) => {
								const repoSlug =
									project.repoOwner && project.repoName
										? `${project.repoOwner}/${project.repoName}`
										: null
								return (
									<li
										key={project.id ?? repoSlug ?? project.href}
										className="bg-background"
									>
										<ProjectRow
											project={project}
											stars={repoSlug ? (stars.get(repoSlug) ?? null) : null}
										/>
									</li>
								)
							})}
						</ul>
					</section>
				</main>
			</HubLayout>
		</LayoutClient>
	)
}

function ProjectRow({
	project,
	stars,
}: {
	project: OpenSourceProject
	stars: number | null
}) {
	const repoSlug =
		project.repoOwner && project.repoName
			? `${project.repoOwner}/${project.repoName}`
			: null
	// The handle for a row that has one, the repo slug otherwise. Never both, and
	// never an empty mono line holding space above the heading.
	const metaLine = project.meta ?? repoSlug
	const isExternal = project.href.startsWith('http')
	const logoHref = project.logoHref ?? project.href
	const logoIsExternal = logoHref.startsWith('http')

	return (
		// Standard editorial split (DESIGN.md rule 4): the copy carries the weight,
		// the wordmark is the lighter peer. The logo comes FIRST in the DOM so it
		// leads on mobile, then is placed into the right column on desktop.
		<div className="grid grid-cols-1 items-center gap-x-10 gap-y-6 px-[18px] py-8 sm:px-11 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:py-10">
			{project.logo ? (
				// Clickable, but hidden from assistive tech and the tab order: a
				// wordmark link would either announce the project twice or read as an
				// unnamed link. Every destination it can point at is also in `links`
				// below, so mouse users get the bigger target and keyboard users lose
				// no route.
				<Link
					href={logoHref}
					aria-hidden
					tabIndex={-1}
					{...(logoIsExternal
						? { target: '_blank', rel: 'noopener noreferrer' }
						: null)}
					className="relative h-20 w-full max-w-[300px] transition-opacity hover:opacity-80 sm:h-24 md:col-start-2 md:row-start-1 md:h-36 md:max-w-none"
				>
					{/* Both variants render and CSS picks one: the theme here is
					    class-driven, so the READMEs' prefers-color-scheme swap would
					    show the wrong logo whenever someone overrides their OS. */}
					<Image
						src={project.logo.light}
						alt=""
						fill
						sizes="(min-width: 768px) 520px, 300px"
						className="object-contain object-left dark:hidden md:object-right"
					/>
					<Image
						src={project.logo.dark}
						alt=""
						fill
						sizes="(min-width: 768px) 520px, 300px"
						className="hidden object-contain object-left dark:block md:object-right"
					/>
				</Link>
			) : project.glyph ? (
				// No README wordmark to show, so the slot takes the hatched
				// placeholder (DESIGN.md rule 6) rather than collapsing — a row with
				// an empty right column would break the alignment of the three above
				// it. Decorative and out of the tab order for the same reason the
				// wordmark is: the heading beside it already names and links the
				// destination.
				<Link
					href={project.href}
					aria-hidden
					tabIndex={-1}
					target="_blank"
					rel="noopener noreferrer"
					className="bg-stripes border-border relative flex h-20 w-full max-w-[300px] items-center justify-center rounded-md border transition-opacity hover:opacity-80 sm:h-24 md:col-start-2 md:row-start-1 md:h-36 md:max-w-none"
				>
					<Youtube
						aria-hidden
						className="text-[color:var(--ah-fg-subtle)] size-10 md:size-14"
						strokeWidth={1.25}
					/>
				</Link>
			) : null}

			<div className="flex flex-col gap-4 md:col-start-1 md:row-start-1">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					{metaLine ? (
						// Not uppercased when it is a handle: `YOUTUBE.COM/@MATTPOCOCKUK`
						// is a different string from the one on the channel, and this line
						// exists to be recognised.
						<p
							className={cn(
								'text-muted-foreground font-mono text-[11px] font-medium tracking-wider',
								repoSlug && !project.meta && 'uppercase',
							)}
						>
							{metaLine}
						</p>
					) : null}
					{stars !== null ? (
						<p className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[11px] font-medium tabular-nums">
							<Star aria-hidden className="text-primary size-3 fill-current" />
							<span className="sr-only">GitHub stars: </span>
							{stars.toLocaleString('en-US')}
						</p>
					) : null}
				</div>

				<Link
					href={project.href}
					{...(isExternal
						? { target: '_blank', rel: 'noopener noreferrer' }
						: null)}
					className="focus-visible:ring-ring group inline-flex items-start gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					<h2 className="text-balance text-2xl font-semibold leading-tight tracking-tight group-hover:underline sm:text-3xl">
						{project.name}
					</h2>
					{isExternal ? (
						<ArrowUpRight
							aria-hidden
							className="mt-1.5 size-4 shrink-0 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
						/>
					) : null}
				</Link>

				<p className="max-w-[70ch] text-base leading-relaxed opacity-70">
					{project.description}
				</p>

				{project.links?.length ? (
					<ul className="flex flex-wrap items-center gap-2 pt-1">
						{project.links.map((link) => {
							const external = link.href.startsWith('http')
							return (
								<li key={link.href}>
									<Link
										href={link.href}
										{...(external
											? { target: '_blank', rel: 'noopener noreferrer' }
											: null)}
										className="border-border text-foreground/80 hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
									>
										{link.label}
										{external ? (
											<ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
										) : null}
									</Link>
								</li>
							)
						})}
					</ul>
				) : null}
			</div>
		</div>
	)
}
