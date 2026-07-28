import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { getRepoStarCount } from '@/lib/github-stars-query'
import {
	OPEN_SOURCE_HERO,
	OPEN_SOURCE_PROJECTS,
	type OpenSourceProject,
} from '@/lib/open-source-content'
import { ArrowUpRight, Star } from 'lucide-react'

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
	const starTargets = OPEN_SOURCE_PROJECTS.filter((p) => p.showStars)
	const starEntries = await Promise.all(
		starTargets.map(
			async (p) =>
				[
					`${p.repoOwner}/${p.repoName}`,
					await getRepoStarCount(p.repoOwner, p.repoName),
				] as const,
		),
	)
	const stars = new Map(starEntries)

	return (
		<LayoutClient withContainer withFooter={false}>
			<HubLayout>
				<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))]">
					<section className="border-b">
						<div className="flex flex-col gap-6 px-8 py-16 sm:px-16 md:py-24">
							<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								{OPEN_SOURCE_HERO.eyebrow}
							</p>
							<h1 className="text-balance text-4xl font-normal leading-[1.05] tracking-tight sm:text-5xl">
								{OPEN_SOURCE_HERO.title}
							</h1>
							<p className="max-w-[65ch] text-base leading-relaxed opacity-80 sm:text-lg">
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
							{OPEN_SOURCE_PROJECTS.map((project) => (
								<li
									key={`${project.repoOwner}/${project.repoName}`}
									className="bg-background"
								>
									<ProjectRow
										project={project}
										stars={
											stars.get(`${project.repoOwner}/${project.repoName}`) ??
											null
										}
									/>
								</li>
							))}
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
	const repoSlug = `${project.repoOwner}/${project.repoName}`
	const isExternal = project.href.startsWith('http')
	const logoHref = project.logoHref ?? project.href
	const logoIsExternal = logoHref.startsWith('http')

	return (
		// Standard editorial split (DESIGN.md rule 4): the copy carries the weight,
		// the wordmark is the lighter peer. The logo comes FIRST in the DOM so it
		// leads on mobile, then is placed into the right column on desktop.
		<div className="grid grid-cols-1 items-center gap-x-10 gap-y-6 px-8 py-8 sm:px-16 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:py-10">
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
			) : null}

			<div className="flex flex-col gap-4 md:col-start-1 md:row-start-1">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<p className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-wider">
						{repoSlug}
					</p>
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
