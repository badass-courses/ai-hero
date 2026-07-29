// Used for root route /[post]

import * as React from 'react'
import { type Metadata, type ResolvingMetadata } from 'next'
import Link from 'next/link'
import { Contributor } from '@/components/contributor'
import { ResourceRow } from '@/components/landing/resource-row'
import { LessonNumberBadge } from './_components/lesson-number-badge'
import { TYPE } from '@/components/landing/type'
import { Share } from '@/components/share'
import {
	filterSectionedResources,
	firstDisplayableSlug,
} from '@/lib/list-sections'
import type { List } from '@/lib/lists'
import { getAllLists, getList, getListWithSections } from '@/lib/lists-query'
import { getServerAuthSession } from '@/server/auth'
import { compileMDX } from '@/utils/compile-mdx'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import { ArrowRight, Github, Share2 } from 'lucide-react'

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { ListNewsletterForm } from './_components/list-newsletter-form'
import { splitListBody } from './_components/split-list-body'

type Props = {
	params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
	const lists = await getAllLists()

	return lists
		.filter((list) => Boolean(list.fields?.slug))
		.map((list) => ({
			slug: list.fields?.slug,
		}))
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const list = await getList(params.slug)

	if (!list) {
		return parent as Metadata
	}

	return {
		title: list.fields.title,
		description: list.fields.description,
		openGraph: {
			images: [
				getOGImageUrlForResource({
					fields: { slug: list.fields.slug },
					id: list.id,
					updatedAt: list.updatedAt,
				}),
			],
		},
	}
}

type LessonRow = {
	kind: 'lesson'
	key: string
	/** Resource id — matched against completed lessons for the progress mark. */
	id: string
	slug: string
	title: string
	description?: string
	image?: string
	/** Seconds, when the lesson's video resource carries a duration. */
	duration?: number
	n: number
}

type Row = { kind: 'section'; key: string; title: string } | LessonRow

/**
 * Course overview, per the redesign's `Course Page.dc.html`: a two-column head
 * (metadata + CTA beside the intro video), the body split into a "why this
 * matters" editorial block and a numbered outcomes grid, the lessons as
 * `.ah-row` cards with the first one accented, and a two-up next-step footer.
 *
 * The lesson-by-lesson navigation still lives in the hub sidebar; the cards
 * here are the "start here" surface, not a duplicate nav.
 *
 * Every block below is optional and degrades to nothing, because this template
 * serves every list on the site and their bodies are not uniform — see
 * `splitListBody` for what a body has to declare to earn the video and the
 * grid.
 */
export default async function ListPage(props: {
	list: List
	params: Promise<{ slug: string }>
}) {
	const list = props.list

	const parts = list.fields.body
		? splitListBody(list.fields.body)
		: { intro: undefined, headline: undefined, outcomes: [], rest: '' }

	// Two compiles rather than one: the intro video renders in the head's
	// right cell, half a page away from the prose it was authored above.
	const introVideo = parts.intro
		? (await compileMDX(parts.intro)).content
		: null
	const body = parts.rest ? (await compileMDX(parts.rest)).content : null

	// The landing's `list` comes from the one-level `getPostOrList`; pull the
	// deep, section-aware tree so sections render as sub-groups with their
	// children (falling back to the shallow rows if the deep fetch fails).
	// Filtering drops unlisted/unpublished items and empty sections.
	const deepList = await getListWithSections(list.fields.slug ?? list.id)
	const displayResources = filterSectionedResources(
		deepList?.resources ?? list.resources,
	)
	const firstSlug = firstDisplayableSlug(displayResources)
	const firstResourceHref = firstSlug ? `/${firstSlug}` : undefined

	// Flatten the sectioned tree into render rows: section headings interleaved
	// with lessons, numbering continuous across the whole series.
	let lessonNumber = 0
	const rows: Row[] = []
	const toLesson = (resource: any): LessonRow | null => {
		if (!resource?.fields?.slug) return null
		return {
			kind: 'lesson',
			key: resource.id,
			id: resource.id,
			slug: String(resource.fields.slug),
			title: String(resource.fields.title ?? ''),
			description: resource.fields.description ?? undefined,
			n: ++lessonNumber,
			...lessonVideoMeta(resource),
		}
	}
	for (const entry of displayResources) {
		const resource = entry?.resource
		if (!resource) continue
		if (resource.type === 'section') {
			rows.push({
				kind: 'section',
				key: resource.id,
				title: String(resource.fields?.title ?? ''),
			})
			for (const child of resource.resources ?? []) {
				const lesson = toLesson(child?.resource)
				if (lesson) rows.push(lesson)
			}
			continue
		}
		const lesson = toLesson(resource)
		if (lesson) rows.push(lesson)
	}

	const totalSeconds = rows.reduce(
		(sum, row) => (row.kind === 'lesson' ? sum + (row.duration ?? 0) : sum),
		0,
	)
	// `lessonNumber` finished the flattening loop as the total, so the count is
	// free here and always matches the cards rendered below.
	const metaBits = [
		introVideo ? 'Video series' : 'Series',
		lessonNumber > 0
			? `${lessonNumber} ${lessonNumber === 1 ? 'lesson' : 'lessons'}`
			: null,
		totalSeconds > 0 ? formatTotal(totalSeconds) : null,
	].filter(Boolean)

	return (
		<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))]">
			{/* HEAD — metadata and CTA left, intro video right. Hairline between
			    the cells comes from the grid (DESIGN rule 2), so the video panel
			    can carry its own raised background without a doubled border. */}
			<section className="border-b">
				{/* The hub sidebar takes 264px before this grid gets a pixel, so
				    the usual `md` split lands the 52px `h1` in a column narrower
				    than its longest word. 1120px viewport is where the title
				    column clears it; below that the head stacks, video under the
				    metadata, which is the mobile pattern anyway. The text column
				    is the heavier one (title, lead, CTA, byline) — same mirrored
				    editorial ratio the landing hero uses. */}
				<div
					className={cn(
						'bg-border grid grid-cols-1 gap-px',
						// No video, no second column: an empty raised panel beside the
						// title reads as a failed image, not as breathing room.
						introVideo &&
							'min-[1120px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]',
					)}
				>
					<div className="bg-background flex flex-col px-[18px] py-16 sm:px-11 md:py-20">
						<div className="mb-5 flex flex-wrap items-center gap-3">
							{list.fields.type !== 'workshop' && (
								<span
									className={cn(
										TYPE.micro,
										'bg-accent-fill text-accent-fill-foreground rounded-[4px] px-1.5 py-1',
									)}
								>
									Free
								</span>
							)}
							<p
								className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}
							>
								{metaBits.join(' · ')}
							</p>
						</div>
						<h1 className={cn(TYPE.title, 'text-balance')}>
							{list.fields.title}
						</h1>
						{list.fields.description && (
							<p
								className={cn(
									TYPE.lead,
									'mt-4 max-w-[46ch] text-pretty text-[color:var(--ah-fg-body)]',
								)}
							>
								{list.fields.description}
							</p>
						)}
						<div className="mt-8 flex flex-wrap items-center gap-3">
							{firstResourceHref && (
								<Link
									href={firstResourceHref}
									className={cn(
										TYPE.meta,
										'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex items-center gap-2 rounded-[9px] px-5 py-3 font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
									)}
								>
									Start lesson 1
									<ArrowRight
										aria-hidden
										className="ease-out-quart size-3.5 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
									/>
								</Link>
							)}
							{list.fields?.github && (
								<Button
									asChild
									variant="outline"
									className="rounded-[9px] px-4"
								>
									<Link href={list.fields.github} target="_blank">
										<Github className="mr-2 size-4" /> Code
									</Link>
								</Button>
							)}
							<Dialog>
								<DialogTrigger asChild>
									<Button variant="ghost" className="rounded-[9px] px-4">
										<Share2 className="mr-2 size-4" /> Share
									</Button>
								</DialogTrigger>
								<DialogContent
									lockScroll={false}
									className="max-w-[min(640px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-lg p-0"
								>
									<DialogTitle className="border-b px-6 py-5 text-xl">
										Share
									</DialogTitle>
									<Share
										variant="dialog"
										title={list.fields.title}
										className="p-6"
									/>
								</DialogContent>
							</Dialog>
						</div>
						<div className="border-border mt-8 flex items-center gap-3 border-t pt-8">
							<Contributor imageSize={32} className={TYPE.meta} />
						</div>
					</div>
					{introVideo && (
						<div className="bg-muted flex flex-col justify-center gap-3 p-8 sm:p-12">
							{/* The player owns its own aspect ratio and radius; this cell
							    only positions it. */}
							<div className="[&_video]:rounded-md">{introVideo}</div>
							<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
								Watch the intro
							</p>
						</div>
					)}
				</div>
			</section>

			{/* WHY THIS MATTERS — headline left, prose right. When the body didn't
			    open with a bolded line the left cell is just the label, which is
			    still the spec's shape rather than a heading invented for it. */}
			{body && (
				<section className="border-b">
					<div className="grid grid-cols-1 gap-6 px-[18px] py-16 sm:px-11 md:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-16">
						<div className="flex flex-col gap-4">
							<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
								Why this matters
							</p>
							{parts.headline && (
								<h2 className={cn(TYPE.heading, 'text-balance')}>
									{parts.headline}
								</h2>
							)}
						</div>
						<article className="prose dark:prose-invert prose-headings:tracking-tight max-w-none [&>*]:max-w-[70ch]">
							{body}
						</article>
					</div>
				</section>
			)}

			{/* WHAT YOU'LL LEARN — numbered, not bulleted: the grid is a set of
			    promises the reader counts, and bullets read as an aside. */}
			{parts.outcomes.length > 0 && (
				<section className="bg-muted border-b">
					<div className="flex flex-col gap-6 px-[18px] py-16 sm:px-11 md:py-20">
						<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
							What you'll learn
						</p>
						<ol className="border-border bg-border grid grid-cols-1 gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
							{parts.outcomes.map((outcome, i) => (
								<li
									key={outcome}
									className="bg-background flex flex-col gap-3 px-6 py-6"
								>
									<span className={cn(TYPE.command, 'text-primary')}>
										{String(i + 1).padStart(2, '0')}
									</span>
									<span className={cn(TYPE.cardTitle, 'text-pretty')}>
										{outcome}
									</span>
								</li>
							))}
							{/* Fillers keep the closing hairline straight on a short row
							    (DESIGN rule 2). */}
							{Array.from({
								length: (3 - (parts.outcomes.length % 3)) % 3,
							}).map((_, i) => (
								<li
									key={`filler-${i}`}
									aria-hidden
									className="bg-background hidden lg:block"
								/>
							))}
						</ol>
					</div>
				</section>
			)}

			{/* LESSONS — `.ah-row` cards. The first is accented: with the sidebar
			    carrying the nav, this list's job is to say where to start. */}
			{rows.length > 0 && (
				<section className="border-b">
					<div className="flex flex-col gap-6 px-[18px] py-16 sm:px-11 md:py-20">
						<div className="flex flex-col gap-3">
							<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
								In this series
							</p>
							<h2 className={cn(TYPE.heading, 'text-balance')}>
								{lessonNumber} {lessonNumber === 1 ? 'lesson' : 'lessons'}, in
								order
							</h2>
						</div>
						<ol className="flex max-w-[940px] flex-col gap-2.5">
							{rows.map((row) =>
								row.kind === 'section' ? (
									<li key={row.key} className="pt-4 first:pt-0">
										<p
											className={cn(
												TYPE.micro,
												'text-[color:var(--ah-fg-label)]',
											)}
										>
											{row.title}
										</p>
									</li>
								) : (
									<li key={row.key}>
										<ResourceRow
											compact
											active={row.n === 1}
											href={`/${row.slug}`}
											title={row.title}
											description={row.description}
											image={row.image}
											fallbackPlaceholder="Lesson"
											badge={
												<LessonNumberBadge
													id={row.id}
													n={row.n}
													accent={row.n === 1}
												/>
											}
											typeLabel={
												row.duration
													? formatTimecode(row.duration)
													: undefined
											}
										/>
									</li>
								),
							)}
						</ol>
					</div>
				</section>
			)}

			{/* NEXT — one step forward and one way to stay, side by side. */}
			<section className="border-border bg-border grid grid-cols-1 gap-px border-b lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div className="bg-background flex flex-col items-start gap-4 px-[18px] py-16 sm:px-11 md:py-20">
					<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						After this series
					</p>
					<h2 className={cn(TYPE.subhead, 'text-balance')}>
						Put it to work with the skills
					</h2>
					<p
						className={cn(
							TYPE.metaProse,
							'max-w-[46ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						Free, open-source skills that turn these fundamentals into a real
						engineering workflow with your agent.
					</p>
					<Link
						href="/skills"
						className={cn(
							TYPE.meta,
							'border-border hover:bg-secondary focus-visible:ring-ring group mt-2 inline-flex items-center gap-2 rounded-[9px] border px-4 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
						)}
					>
						Browse the skills
						<ArrowRight
							aria-hidden
							className="text-primary ease-out-quart size-3.5 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
						/>
					</Link>
				</div>
				<div className="bg-muted flex flex-col gap-4 px-[18px] py-16 sm:px-11 md:py-20">
					<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						Keep learning
					</p>
					<h2 className={cn(TYPE.subhead, 'text-balance')}>
						New lessons the day they land
					</h2>
					<ListNewsletterForm />
				</div>
			</section>
		</main>
	)
}

/**
 * Thumbnail and duration for a lesson card, read off the lesson's own video
 * resource. Only present for top-level lessons: the deep list query stops one
 * level below a section, so lessons nested in one render without a poster
 * rather than costing another round trip per section.
 */
function lessonVideoMeta(resource: any): { image?: string; duration?: number } {
	const video = resource?.resources?.find(
		(child: any) => child?.resource?.type === 'videoResource',
	)?.resource
	const playbackId = video?.fields?.muxPlaybackId
	const duration = video?.fields?.duration
	const authored =
		typeof resource?.fields?.image === 'string'
			? resource.fields.image
			: undefined
	const thumbnailTime =
		typeof resource?.fields?.thumbnailTime === 'number'
			? `&time=${resource.fields.thumbnailTime}`
			: ''

	return {
		image:
			authored ??
			(typeof playbackId === 'string' && playbackId
				? `https://image.mux.com/${playbackId}/thumbnail.jpg?width=264&height=156&fit_mode=smartcrop${thumbnailTime}`
				: undefined),
		duration: typeof duration === 'number' && duration > 0 ? duration : undefined,
	}
}

/** `7:12` — a lesson's own runtime, which readers scan as a timecode. */
function formatTimecode(seconds: number): string {
	const total = Math.round(seconds)
	const minutes = Math.floor(total / 60)
	return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** `29 min` — the series total, which is a commitment, not a timecode. */
function formatTotal(seconds: number): string {
	return `${Math.max(1, Math.round(seconds / 60))} min`
}

export async function ListActionBar({
	list,
	className,
}: {
	list: List | null
	className?: string
}) {
	const { ability } = await getServerAuthSession()

	return (
		<>
			{list && ability.can('update', 'Content') ? (
				<Button className={cn(className)} asChild variant="outline" size="sm">
					<Link href={`/lists/${list.fields?.slug || list.id}/edit`}>Edit</Link>
				</Button>
			) : null}
		</>
	)
}
