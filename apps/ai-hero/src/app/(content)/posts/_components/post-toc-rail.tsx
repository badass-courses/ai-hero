'use client'

import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { Share } from '@/components/share'
import { useActiveHeadingContext } from '@/hooks/use-active-heading'
import {
	extractMarkdownHeadings,
	type MarkdownHeading,
} from '@/utils/extract-markdown-headings'
import { AlignLeft, ArrowRight, ChevronRight } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { TocText } from './post-toc'

interface TocSection {
	slug: string
	text: string
}

interface TocModel {
	/** The h2s, in document order. The rail lists these and nothing else. */
	sections: TocSection[]
	/** Every heading slug in document order, h3s included. */
	order: string[]
	/** Any heading slug → the h2 it lives under. */
	ownerBySlug: Map<string, string>
}

const EYEBROW = cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')

function getTocModel(markdown: string): TocModel {
	const sections: TocSection[] = []
	const order: string[] = []
	const ownerBySlug = new Map<string, string>()

	const walk = (nodes: MarkdownHeading[], owner: string | null) => {
		for (const node of nodes) {
			let nextOwner = owner
			if (node.level === 2) {
				sections.push({ slug: node.slug, text: node.text })
				nextOwner = node.slug
			}
			order.push(node.slug)
			if (nextOwner) ownerBySlug.set(node.slug, nextOwner)
			walk(node.items, nextOwner)
		}
	}

	walk(extractMarkdownHeadings(markdown), null)

	return { sections, order, ownerBySlug }
}

/**
 * The rail lists h2s only, but the `Heading` component registers every heading
 * it renders — so an h3 scrolling through the viewport has to mark its parent
 * h2 rather than leave the rail with nothing current. When no heading is in
 * view at all (a long code block, the space between sections) the last answer
 * stands: blanking the rail mid-scroll reads as a bug.
 */
function useActiveSection(model: TocModel): string | null {
	const { visibleHeadings } = useActiveHeadingContext()
	const [lastActive, setLastActive] = React.useState<string | null>(null)

	// The section in view right now — null in the gaps between them.
	const current = React.useMemo(() => {
		let found: string | null = null
		for (const slug of model.order) {
			if (visibleHeadings.has(slug)) {
				found = model.ownerBySlug.get(slug) ?? found
			}
		}
		return found
	}, [model, visibleHeadings])

	// The memory is committed in an effect rather than written during render.
	// A ref mutated inside `useMemo` is not safe under concurrent rendering —
	// React may discard and re-run a memo, so the value read back depended on
	// how many times it happened to run.
	React.useEffect(() => {
		if (current) setLastActive(current)
	}, [current])

	// `current` still wins the frame it appears in, so nothing waits on the
	// effect; `lastActive` only answers for the gaps.
	return current ?? lastActive
}

/**
 * A part of the page that is not a heading: the lesson pager, the related +
 * newsletter grid. The rail lists these under the article's own h2s so it maps
 * the whole page rather than only the prose — a reader looking for "what's
 * after this" should not have to scroll to find out that anything is.
 *
 * The caller decides which exist, because the same route ends four different
 * ways (skill actions, pager, related grid, none of it). Each `id` must be on
 * a real element or the row silently drops out of the spy — never out of the
 * list, since a link to a missing anchor is a dead row.
 */
export type TocLandmark = { id: string; label: string }

/**
 * The landmark equivalent of `useActiveSection`. Landmarks are not headings —
 * nothing registers them with `ActiveHeadingContext` — so the rail observes
 * them itself. Same rule as the heading spy when several are in view at once:
 * the last one in document order wins.
 *
 * The band is deliberately the middle of the viewport rather than the top: the
 * page's last two blocks are short and land together on tall screens, and a
 * top-edge trigger lit the pager for the entire scroll to the bottom.
 */
function useActiveLandmark(landmarks: TocLandmark[]): string | null {
	const [active, setActive] = React.useState<string | null>(null)
	const key = landmarks.map((landmark) => landmark.id).join(',')

	React.useEffect(() => {
		const ids = key ? key.split(',') : []
		const elements = ids
			.map((id) => document.getElementById(id))
			.filter((element): element is HTMLElement => element !== null)
		if (elements.length === 0) return

		const visible = new Set<string>()
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) visible.add(entry.target.id)
					else visible.delete(entry.target.id)
				}
				let next: string | null = null
				for (const id of ids) if (visible.has(id)) next = id
				setActive(next)
			},
			{ rootMargin: '-20% 0px -55% 0px' },
		)
		for (const element of elements) observer.observe(element)
		return () => observer.disconnect()
	}, [key])

	return active
}

/**
 * The in-page CTAs, collected from the DOM after mount.
 *
 * They are NOT passed down like `landmarks` are, and deliberately: the rail is
 * rendered by the page, while the promos are inside the compiled MDX (the
 * auto-inserted line, any hand-placed `PromoCard`) or inside `PostBody` below
 * it. The page would have to re-derive the auto-insert decision and parse the
 * body to know they exist. Instead each CTA carries `data-toc-cta` and
 * `data-toc-label` — one attribute pair per component, added where the CTA is
 * already deciding its own copy, so a new promo shows up in the rail by
 * existing rather than by being registered somewhere else.
 *
 * Each row is placed under the last h2 above it, so the rail keeps document
 * order: a mid-article promo sits between the sections it actually sits
 * between, not in a tray at the bottom.
 *
 * PRECONDITION: every CTA must be in the DOM by the time this effect runs. It
 * scans ONCE — there is no observer. That holds because the MDX components are
 * `next/dynamic` WITHOUT `ssr: false`, so they arrive in the server HTML. A CTA
 * that ever becomes client-only (`ssr: false`, or mounted behind a fetch) will
 * not appear in the rail, and will fail silently — the rail will simply be
 * short a row. Add a re-scan here before introducing one.
 */
type CtaLandmark = { id: string; label: string; afterSlug: string | null }

function useCtaLandmarks(sectionSlugs: string[]): CtaLandmark[] {
	const [ctas, setCtas] = React.useState<CtaLandmark[]>([])
	const key = sectionSlugs.join(',')

	React.useEffect(() => {
		const elements = Array.from(
			document.querySelectorAll<HTMLElement>('[data-toc-cta]'),
		)
		if (elements.length === 0) {
			setCtas([])
			return
		}

		const headings = sectionSlugs
			.map((slug) => document.getElementById(slug))
			.filter((element): element is HTMLElement => element !== null)

		const next = elements.map((element, index) => {
			// A CTA that never needed an anchor gets one, so its row can link
			// somewhere. Ids are only assigned when missing, so the ones the
			// components DO set (`course-cta`, `skill-actions`) stay stable.
			if (!element.id) element.id = `toc-cta-${index + 1}`
			let afterSlug: string | null = null
			for (const heading of headings) {
				const precedes =
					heading.compareDocumentPosition(element) &
					Node.DOCUMENT_POSITION_FOLLOWING
				if (precedes) afterSlug = heading.id
			}
			return {
				id: element.id,
				label: element.dataset.tocLabel ?? 'Read more',
				afterSlug,
			}
		})
		setCtas(next)
	}, [key])

	return ctas
}

const ROW_CLASS =
	// The spec's `.ah-toc__link`: a hairline the whole list hangs off, with the
	// active step lit from the same line. There is no 13px step in TYPE because
	// this is chrome, not text.
	'focus-visible:ring-ring flex w-full items-center gap-1.5 border-l py-1.5 pl-[13px] text-[13px] leading-[1.4] text-[color:var(--ah-fg-subtle)] transition-colors [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 hover:text-foreground'

/** Gold border in both themes, but accent *type* is ink on paper — DESIGN rule 7. */
const ROW_ACTIVE_CLASS = 'border-l-accent-fill text-primary'

type TocRow = {
	id: string
	label: React.ReactNode
	/** A CTA row: same list, but it says it is somewhere to GO, not to read. */
	isCta: boolean
}

function TocLinks({
	model,
	landmarks = [],
	closeOnSelect = false,
}: {
	model: TocModel
	landmarks?: TocLandmark[]
	/** Collapse the enclosing `<details>` after a jump, so the body is not
	 *  pushed down by a list the reader is finished with. */
	closeOnSelect?: boolean
}) {
	const sectionSlugs = React.useMemo(
		() => model.sections.map((section) => section.slug),
		[model],
	)
	const ctas = useCtaLandmarks(sectionSlugs)
	// One spy for everything that is not a heading. CTAs and landmarks are the
	// same kind of target as far as scroll position is concerned.
	const nonHeading = React.useMemo(
		() => [...ctas, ...landmarks],
		[ctas, landmarks],
	)
	const activeAnchor = useActiveLandmark(nonHeading)
	// Past the prose, the rail follows the page rather than the last heading it
	// saw: anything else in view outranks the section the heading spy is holding.
	const activeSlug = useActiveSection(model)
	const activeSection = activeAnchor ? null : activeSlug

	const rows: TocRow[] = React.useMemo(() => {
		const ctaRow = (cta: CtaLandmark): TocRow => ({
			id: cta.id,
			label: cta.label,
			isCta: true,
		})
		return [
			// A promo above the first h2 (or in an article with none).
			...ctas.filter((cta) => cta.afterSlug === null).map(ctaRow),
			...model.sections.flatMap((section) => [
				{
					id: section.slug,
					label: <TocText>{section.text}</TocText>,
					isCta: false,
				},
				...ctas.filter((cta) => cta.afterSlug === section.slug).map(ctaRow),
			]),
			// The page's endings always close the list.
			...landmarks.map((landmark) => ({
				id: landmark.id,
				label: landmark.label,
				isCta: false,
			})),
		]
	}, [model, ctas, landmarks])

	return (
		<ul className="flex flex-col">
			{rows.map((row) => {
				const active = row.isCta
					? row.id === activeAnchor
					: row.id === activeSection || row.id === activeAnchor
				return (
					<li key={row.id} className="flex">
						<Link
							href={`#${row.id}`}
							aria-current={active ? 'location' : undefined}
							onClick={(event) => {
								if (!closeOnSelect) return
								event.currentTarget.closest('details')?.removeAttribute('open')
							}}
							className={cn(ROW_CLASS, active && ROW_ACTIVE_CLASS)}
						>
							<span className="min-w-0">{row.label}</span>
							{/* The one mark that separates a place to GO from a place to
							    read. An icon rather than a colour, because colour in this
							    rail already means "you are here". */}
							{row.isCta ? (
								<ArrowRight
									aria-hidden
									className="mt-px size-3 shrink-0 opacity-50"
								/>
							) : null}
						</Link>
					</li>
				)
			})}
		</ul>
	)
}

function ShareBlock({
	title,
	className,
}: {
	title?: string
	className?: string
}) {
	return (
		<div className={className}>
			<p className={cn(EYEBROW, 'mb-2.5')}>Share</p>
			<Share variant="rail" title={title} />
		</div>
	)
}

/**
 * The article shell's right column: `position: sticky` under the nav, scrolling
 * on its own when the section list outgrows the viewport. Below `md` the rail
 * drops out of the grid entirely and `PostToCDisclosure` takes over.
 */
export function PostToCRail({
	markdown,
	title,
	landmarks,
	className,
	children,
}: {
	markdown: string
	title?: string
	/** Non-heading parts of the page, listed under the h2s. See `TocLandmark`. */
	landmarks?: TocLandmark[]
	className?: string
	/**
	 * The rail's middle slot, between the section list and share. Skill pages
	 * put the workflow-phase rail here; ordinary articles pass nothing.
	 */
	children?: React.ReactNode
}) {
	const model = React.useMemo(() => getTocModel(markdown), [markdown])
	// An article with no h2s can still have an ending worth listing, so the nav
	// is gated on having ANY row rather than on having prose sections.
	const hasSections = model.sections.length > 0 || (landmarks?.length ?? 0) > 0

	return (
		<aside className={cn('hidden border-l md:block', className)}>
			{/* Half the body column's top padding (`pt-10` → `pt-5`), on purpose:
			    the prose is set on a baseline that has to clear the rule above it,
			    and the rail's first line is a 11px eyebrow. Matching the two put a
			    40px hole above a label that is a third the height of the text it
			    was aligning with. */}
			<div className="sticky top-(--nav-height) flex max-h-[calc(100vh-var(--nav-height))] flex-col gap-6 overflow-auto px-5 pb-8 pt-5">
				{hasSections && (
					<nav aria-label="On this page">
						<p className={cn(EYEBROW, 'mb-3')}>On this page</p>
						<TocLinks model={model} landmarks={landmarks} />
					</nav>
				)}
				{children ? (
					<div className={cn(hasSections && 'border-t pt-5')}>{children}</div>
				) : null}
				<ShareBlock
					title={title}
					className={cn((hasSections || children) && 'border-t pt-5')}
				/>
			</div>
		</aside>
	)
}

/**
 * The mobile equivalent of the rail: the same h2 array, closed by default,
 * sitting under the page head rather than floating over the body. Native
 * `<details>` because it needs no state, no observer and no JS to open.
 */
export function PostToCDisclosure({
	markdown,
	landmarks,
	className,
}: {
	markdown: string
	landmarks?: TocLandmark[]
	className?: string
}) {
	const model = React.useMemo(() => getTocModel(markdown), [markdown])

	if (model.sections.length === 0 && (landmarks?.length ?? 0) === 0) return null

	return (
		<details className={cn('group md:hidden', className)}>
			<summary className="flex cursor-pointer list-none items-center gap-2.5 px-8 py-3.5 [&::-webkit-details-marker]:hidden">
				<AlignLeft className="size-4 shrink-0 opacity-60" aria-hidden="true" />
				<span className={TYPE.meta}>On this page</span>
				<ChevronRight
					// `group-open:` generates nothing here, so match the attribute
					// directly: `.group[open] &`.
					className="group-[[open]]:rotate-90 ml-auto size-4 shrink-0 opacity-60 transition-transform motion-reduce:transition-none"
					aria-hidden="true"
				/>
			</summary>
			<nav aria-label="On this page" className="px-8 pb-5">
				<TocLinks model={model} landmarks={landmarks} closeOnSelect />
			</nav>
		</details>
	)
}
