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
import { AlignLeft, ChevronRight } from 'lucide-react'

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
	const lastActiveRef = React.useRef<string | null>(null)

	return React.useMemo(() => {
		let current: string | null = null
		for (const slug of model.order) {
			if (visibleHeadings.has(slug)) {
				current = model.ownerBySlug.get(slug) ?? current
			}
		}
		if (current) lastActiveRef.current = current
		return lastActiveRef.current
	}, [model, visibleHeadings])
}

function TocLinks({
	model,
	closeOnSelect = false,
}: {
	model: TocModel
	/** Collapse the enclosing `<details>` after a jump, so the body is not
	 *  pushed down by a list the reader is finished with. */
	closeOnSelect?: boolean
}) {
	const activeSlug = useActiveSection(model)

	return (
		<ul className="flex flex-col">
			{model.sections.map((section) => {
				const active = section.slug === activeSlug
				return (
					<li key={section.slug} className="flex">
						<Link
							href={`#${section.slug}`}
							aria-current={active ? 'location' : undefined}
							onClick={(event) => {
								if (!closeOnSelect) return
								event.currentTarget.closest('details')?.removeAttribute('open')
							}}
							className={cn(
								// The spec's `.ah-toc__link`: a hairline the whole list hangs
								// off, with the active step lit from the same line. There is
								// no 13px step in TYPE because this is chrome, not text.
								'focus-visible:ring-ring block w-full border-l py-1.5 pl-[13px] text-[13px] leading-[1.4] text-[color:var(--ah-fg-subtle)] transition-colors [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2',
								'hover:text-foreground',
								// Gold border in both themes, but accent *type* is ink on
								// paper — DESIGN rule 7.
								active && 'border-l-accent-fill text-primary',
							)}
						>
							<TocText>{section.text}</TocText>
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
	className,
	children,
}: {
	markdown: string
	title?: string
	className?: string
	/**
	 * The rail's middle slot, between the section list and share. Skill pages
	 * put the workflow-phase rail here; ordinary articles pass nothing.
	 */
	children?: React.ReactNode
}) {
	const model = React.useMemo(() => getTocModel(markdown), [markdown])
	const hasSections = model.sections.length > 0

	return (
		<aside className={cn('hidden border-l md:block', className)}>
			<div className="sticky top-(--nav-height) flex max-h-[calc(100vh-var(--nav-height))] flex-col gap-6 overflow-auto px-5 pb-8 pt-10">
				{hasSections && (
					<nav aria-label="On this page">
						<p className={cn(EYEBROW, 'mb-3')}>On this page</p>
						<TocLinks model={model} />
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
	className,
}: {
	markdown: string
	className?: string
}) {
	const model = React.useMemo(() => getTocModel(markdown), [markdown])

	if (model.sections.length === 0) return null

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
				<TocLinks model={model} closeOnSelect />
			</nav>
		</details>
	)
}
