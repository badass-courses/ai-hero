'use client'

import * as React from 'react'
import Link from 'next/link'
import { useActiveHeadingContext } from '@/hooks/use-active-heading'
import {
	extractMarkdownHeadings,
	type MarkdownHeading,
} from '@/utils/extract-markdown-headings'
import { AlignLeft, ChevronRight } from 'lucide-react'
import { useInteractOutside } from 'react-aria'
import ReactMarkdown from 'react-markdown'

import { cn } from '@coursebuilder/ui/utils/cn'

interface FlatItem {
	slug: string
	text: string
	depth: number
}

interface ComputedSvg {
	width: number
	height: number
	path: string
	measurements: Array<{ slug: string; x: number; top: number; bottom: number }>
}

interface ActiveBox {
	top: number
	height: number
	startIdx: number
	endIdx: number
}

interface ActiveRange {
	startIdx: number
	endIdx: number
	isUp: boolean
	item: FlatItem
}

const BASE_OFFSET = 8

function getLineOffset(depth: number): number {
	if (depth <= 0) return BASE_OFFSET
	if (depth === 1) return BASE_OFFSET + 8
	return BASE_OFFSET + 16
}

function getItemInlinePadding(depth: number): number {
	return getLineOffset(depth) + 12
}

function flattenHeadings(
	headings: MarkdownHeading[],
	depth = 0,
	out: FlatItem[] = [],
): FlatItem[] {
	for (const heading of headings) {
		out.push({ slug: heading.slug, text: heading.text, depth })
		if (heading.items.length > 0) {
			flattenHeadings(heading.items, depth + 1, out)
		}
	}
	return out
}

function getRenderedItems(markdown: string): FlatItem[] {
	const tree = extractMarkdownHeadings(markdown)
	const prune = (headings: MarkdownHeading[]): MarkdownHeading[] => {
		return headings
			.filter((heading) => heading.level < 4)
			.map((heading) => ({ ...heading, items: prune(heading.items) }))
	}
	return flattenHeadings(prune(tree))
}

function getActiveRange(
	items: FlatItem[],
	visibleHeadings: Map<string, unknown>,
	previous: ActiveRange | null,
) {
	let firstIdx = -1
	let lastIdx = -1

	for (let i = 0; i < items.length; i++) {
		const item = items[i]
		if (!item) continue
		if (visibleHeadings.has(item.slug)) {
			if (firstIdx === -1) firstIdx = i
			lastIdx = i
		}
	}

	if (firstIdx === -1 || lastIdx === -1) {
		return previous
	}

	let isUp = false
	if (previous) {
		isUp =
			previous.startIdx > firstIdx ||
			previous.endIdx > lastIdx ||
			(previous.startIdx === firstIdx &&
				previous.endIdx === lastIdx &&
				previous.isUp)
	}

	const item = items[isUp ? firstIdx : lastIdx]
	if (!item) return previous

	return {
		startIdx: firstIdx,
		endIdx: lastIdx,
		isUp,
		item,
	}
}

function TocText({ children }: { children: string }) {
	return (
		<ReactMarkdown
			components={{
				// Chrome Translate replaces text nodes with <font> elements. Keep the
				// markdown output behind real elements so changing the active heading
				// never makes React remove a text node that Translate moved.
				// https://github.com/facebook/react/issues/11538#issuecomment-390386520
				p: ({ children }) => <span>{children}</span>,
				a: ({ children }) => <span>{children}</span>,
				code: ({ children }) => (
					<code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]">
						{children}
					</code>
				),
			}}
		>
			{children}
		</ReactMarkdown>
	)
}

function TocRail({
	items,
	onSelect,
}: {
	items: FlatItem[]
	onSelect?: () => void
}) {
	const { visibleHeadings } = useActiveHeadingContext()
	const containerRef = React.useRef<HTMLOListElement>(null)
	const [svg, setSvg] = React.useState<ComputedSvg | null>(null)
	const directionRef = React.useRef<{
		startIdx: number
		endIdx: number
		isUp: boolean
	} | null>(null)
	const lastActiveBoxRef = React.useRef<ActiveBox | null>(null)

	const recomputePath = React.useCallback(() => {
		const container = containerRef.current
		if (!container || container.clientHeight === 0 || items.length === 0) {
			return
		}

		let width = 0
		let height = 0
		let previousX = 0
		let previousBottom = 0
		let path = ''
		const measurements: ComputedSvg['measurements'] = []

		for (const item of items) {
			const anchor = container.querySelector<HTMLElement>(
				`a[data-toc-slug="${item.slug}"]`,
			)
			if (!anchor) continue

			const styles = getComputedStyle(anchor)
			const x = getLineOffset(item.depth) + 0.5
			const top = anchor.offsetTop + parseFloat(styles.paddingTop || '0')
			const bottom =
				anchor.offsetTop +
				anchor.clientHeight -
				parseFloat(styles.paddingBottom || '0')

			width = Math.max(x + 8, width)
			height = Math.max(height, bottom)

			if (path === '') {
				path += `M${x} ${top} L${x} ${bottom}`
			} else {
				path += ` C ${previousX} ${top - 4} ${x} ${previousBottom + 4} ${x} ${top} L${x} ${bottom}`
			}

			measurements.push({ slug: item.slug, x, top, bottom })
			previousX = x
			previousBottom = bottom
		}

		setSvg(
			measurements.length > 0 ? { width, height, path, measurements } : null,
		)
	}, [items])

	React.useEffect(() => {
		const container = containerRef.current
		if (!container) return

		recomputePath()

		const observer = new ResizeObserver(() => recomputePath())
		observer.observe(container)

		if (typeof document !== 'undefined' && 'fonts' in document) {
			document.fonts.ready.then(() => recomputePath()).catch(() => {})
		}

		return () => observer.disconnect()
	}, [recomputePath])

	const activeBox = React.useMemo<ActiveBox | null>(() => {
		if (!svg || svg.measurements.length === 0) {
			return lastActiveBoxRef.current
		}

		let firstIdx = -1
		let lastIdx = -1
		for (let i = 0; i < svg.measurements.length; i++) {
			const measurement = svg.measurements[i]
			if (!measurement) continue
			if (visibleHeadings.has(measurement.slug)) {
				if (firstIdx === -1) firstIdx = i
				lastIdx = i
			}
		}

		if (firstIdx === -1 || lastIdx === -1) {
			return lastActiveBoxRef.current
		}

		const first = svg.measurements[firstIdx]
		const last = svg.measurements[lastIdx]
		if (!first || !last) return lastActiveBoxRef.current

		const next = {
			top: first.top,
			height: last.bottom - first.top,
			startIdx: firstIdx,
			endIdx: lastIdx,
		}
		lastActiveBoxRef.current = next
		return next
	}, [svg, visibleHeadings])

	const direction = React.useMemo(() => {
		if (!activeBox) return directionRef.current
		const previous = directionRef.current
		let isUp = false
		if (previous) {
			isUp =
				previous.startIdx > activeBox.startIdx ||
				previous.endIdx > activeBox.endIdx ||
				(previous.startIdx === activeBox.startIdx &&
					previous.endIdx === activeBox.endIdx &&
					previous.isUp)
		}
		const next = {
			startIdx: activeBox.startIdx,
			endIdx: activeBox.endIdx,
			isUp,
		}
		directionRef.current = next
		return next
	}, [activeBox])

	const thumb = React.useMemo(() => {
		if (!svg || !activeBox || !direction) return null
		const targetIdx = direction.isUp ? activeBox.startIdx : activeBox.endIdx
		const measurement = svg.measurements[targetIdx]
		if (!measurement) return null
		const y = direction.isUp ? measurement.top : measurement.bottom
		return { x: measurement.x - 1.5, y: y - 1.5 }
	}, [svg, activeBox, direction])

	return (
		<div className="relative">
			{svg && (
				<>
					<svg
						aria-hidden="true"
						role="presentation"
						xmlns="http://www.w3.org/2000/svg"
						viewBox={`0 0 ${svg.width} ${svg.height}`}
						width={svg.width}
						height={svg.height}
						className="pointer-events-none absolute left-0 top-0"
					>
						<path
							d={svg.path}
							strokeWidth="1"
							fill="none"
							className="stroke-foreground/15"
						/>
					</svg>
					<svg
						aria-hidden="true"
						role="presentation"
						xmlns="http://www.w3.org/2000/svg"
						viewBox={`0 0 ${svg.width} ${svg.height}`}
						width={svg.width}
						height={svg.height}
						className="pointer-events-none absolute left-0 top-0 transition-[clip-path] duration-150 ease-out motion-reduce:transition-none"
						style={{
							clipPath: activeBox
								? `polygon(0 ${activeBox.top}px, 100% ${activeBox.top}px, 100% ${activeBox.top + activeBox.height}px, 0 ${activeBox.top + activeBox.height}px)`
								: 'polygon(0 0, 0 0, 0 0, 0 0)',
						}}
					>
						<path
							d={svg.path}
							strokeWidth="1.5"
							fill="none"
							className="stroke-foreground"
						/>
					</svg>
					{thumb && (
						<div
							aria-hidden="true"
							className="bg-foreground pointer-events-none absolute left-0 top-0 size-[3px] rounded-full transition-transform duration-150 ease-out motion-reduce:transition-none"
							style={{
								transform: `translate(${thumb.x}px, ${thumb.y}px)`,
							}}
						/>
					)}
				</>
			)}
			<ol ref={containerRef} className="relative flex flex-col">
				{items.map((item) => {
					const active = visibleHeadings.has(item.slug)
					return (
						<li key={item.slug} className="flex">
							<Link
								href={`#${item.slug}`}
								data-toc-slug={item.slug}
								aria-current={active ? 'location' : undefined}
								className={cn(
									'text-foreground/60 hover:text-foreground relative block w-full py-1.5 pr-2 text-sm leading-snug transition-colors [overflow-wrap:anywhere]',
									active && 'text-foreground font-medium',
								)}
								style={{
									paddingInlineStart: getItemInlinePadding(item.depth),
								}}
								onClick={onSelect}
							>
								<TocText>{item.text}</TocText>
							</Link>
						</li>
					)
				})}
			</ol>
		</div>
	)
}

export default function PostToC({
	markdown,
	className,
}: {
	markdown: string
	className?: string
}) {
	const items = React.useMemo(() => getRenderedItems(markdown), [markdown])
	const { visibleHeadings } = useActiveHeadingContext()
	const [isOpen, setIsOpen] = React.useState(false)
	const containerRef = React.useRef<HTMLElement>(null)
	const activeRangeRef = React.useRef<ActiveRange | null>(null)
	const activeItem = React.useMemo(() => {
		const next = getActiveRange(items, visibleHeadings, activeRangeRef.current)
		activeRangeRef.current = next
		return next?.item ?? null
	}, [items, visibleHeadings])

	useInteractOutside({
		ref: containerRef,
		onInteractOutside: () => setIsOpen(false),
	})

	React.useEffect(() => {
		if (!isOpen) return

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setIsOpen(false)
		}

		document.addEventListener('keydown', handleKeyDown)
		return () => document.removeEventListener('keydown', handleKeyDown)
	}, [isOpen])

	if (items.length < 3) {
		return null
	}

	return (
		<nav
			ref={containerRef}
			className={cn(
				'dark:bg-background/80 bg-card/80 sticky top-[62px] z-50 flex min-w-0 flex-col border-y backdrop-blur-lg',
				className,
			)}
			aria-label="On this page"
		>
			<div className="px-10">
				<div className="mx-auto flex w-full max-w-4xl items-center">
					<button
						type="button"
						onClick={() => setIsOpen((current) => !current)}
						aria-expanded={isOpen}
						className="flex h-10 min-w-0 cursor-pointer items-center justify-start gap-1 px-0 text-sm"
					>
						<AlignLeft className="size-4 shrink-0" />
						<span className="shrink-0 font-normal">On this page</span>
						<ChevronRight
							className={cn(
								'size-3 shrink-0 translate-x-0 rotate-0 transition ease-in-out',
								isOpen && 'translate-x-1 rotate-90',
							)}
						/>
						<span
							className={cn(
								'min-w-0 flex-1 truncate text-left opacity-80 transition ease-in-out',
								isOpen && 'translate-x-1 opacity-0',
							)}
						>
							<TocText>{activeItem?.text ?? items[0]?.text ?? ''}</TocText>
						</span>
					</button>
				</div>
			</div>
			{isOpen && (
				<div className="dark:bg-background bg-card absolute left-0 top-10 max-h-[55vh] w-full overflow-y-auto border-b px-10 pb-5">
					<div className="mx-auto w-full max-w-4xl">
						<TocRail items={items} onSelect={() => setIsOpen(false)} />
					</div>
				</div>
			)}
		</nav>
	)
}
