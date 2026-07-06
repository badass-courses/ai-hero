'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { track } from '@/utils/analytics'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
	ArrowRight,
	BookA,
	BookOpen,
	Calendar,
	Cog,
	FileText,
	GraduationCap,
	Map as MapIcon,
	Play,
} from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { FEATURED_PROMO, type Promo } from '../navigation/promo-config'
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from '../ui/command'
import { DialogOverlay, DialogPortal } from '../ui/dialog'
import {
	CURATED_DEFAULTS,
	PALETTE_PROMO,
	type PaletteItem,
	type PaletteItemType,
} from './search-palette-config'

/**
 * ⌘K search palette (wireframe 15).
 *
 * Flat, mixed result list — no "Articles" / "Skills" / "Courses" group
 * headings. It's all content; the icon is the type hint. Before the visitor
 * types, the list shows the curated defaults from `search-palette-config.ts`.
 * Typing replaces them with live results from `/api/search` (Typesense,
 * keyword mode for type-ahead latency). The promo row and keyboard hints stay
 * fixed below the scrollable results — the promo is never pushed out.
 *
 * Every row is a real `<Link>` (status-bar URL, cmd/middle-click work);
 * keyboard ⏎ routes through the same href. The promo row resolves dynamically
 * from `/api/palette-promo` (site-wide override → next cohort → static
 * fallback).
 *
 * Desktop: 540px, centered on a dimmed backdrop. Mobile: full-screen overlay
 * with a Cancel button instead of the esc hint.
 */

/** One palette result row — curated defaults and live hits share this shape. */
type PaletteResult = PaletteItem & { id: string }

const TYPE_ICONS: Record<PaletteItemType, React.ComponentType<any>> = {
	map: MapIcon,
	skill: Cog,
	course: GraduationCap,
	workshop: GraduationCap,
	cohort: GraduationCap,
	tutorial: BookOpen,
	lesson: Play,
	event: Calendar,
	dictionary: BookA,
	post: FileText,
	article: FileText,
}

function iconForType(type: string) {
	return TYPE_ICONS[type as PaletteItemType] ?? FileText
}

/**
 * Hit types whose `view` path is self-contained. `lesson`/`solution`/`section`
 * need parent (workshop/list) context the search API doesn't resolve — their
 * root-level URLs 404, so they're excluded from palette results.
 */
const LINKABLE_HIT_TYPES = new Set([
	'post',
	'article',
	'podcast',
	'tip',
	'comic',
	'tutorial',
	'list',
	'workshop',
	'cohort',
	'event',
	'event-series',
	'skill-changelog',
	'dictionary',
	'dictionary-entry',
])

/** Map an /api/search hit to a palette row. Hits carry absolute URLs. */
function hitToResult(hit: {
	id: string
	type: string
	title: string
	url: string
}): PaletteResult | null {
	if (!hit?.title || !hit?.url) return null
	if (!LINKABLE_HIT_TYPES.has(hit.type)) return null
	let href: string
	try {
		href = new URL(hit.url).pathname
	} catch {
		return null
	}
	return {
		id: hit.id,
		title: hit.title,
		href,
		type: (hit.type || 'post') as PaletteItemType,
	}
}

const SEARCH_DEBOUNCE_MS = 200
const SEARCH_PER_PAGE = 8

export function SearchPalette({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const router = useRouter()
	const [query, setQuery] = React.useState('')
	const [results, setResults] = React.useState<PaletteResult[]>([])
	const [isSearching, setIsSearching] = React.useState(false)
	// Static resolution first (no pop-in); replaced by the dynamic promo once
	// fetched (manual override → upcoming cohort → static fallback).
	const [promo, setPromo] = React.useState<Promo | null>(
		FEATURED_PROMO ?? PALETTE_PROMO,
	)

	// Global shortcut: ⌘K / Ctrl+K toggles the palette.
	React.useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				onOpenChange(!open)
				if (!open) track('search_palette_opened', { via: 'keyboard' })
			}
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [open, onOpenChange])

	// Resolve the dynamic promo when the palette opens (cached server-side).
	React.useEffect(() => {
		if (!open) return
		const controller = new AbortController()
		fetch('/api/palette-promo', { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (data && 'promo' in data) setPromo(data.promo ?? null)
			})
			.catch(() => {})
		return () => controller.abort()
	}, [open])

	// Reset per open so a reopened palette starts at the curated defaults.
	React.useEffect(() => {
		if (!open) {
			setQuery('')
			setResults([])
			setIsSearching(false)
		}
	}, [open])

	// Debounced server search; server ranks, cmdk does not re-filter.
	React.useEffect(() => {
		const trimmed = query.trim()
		if (!trimmed) {
			setResults([])
			setIsSearching(false)
			return
		}
		setIsSearching(true)
		const controller = new AbortController()
		const timeout = setTimeout(async () => {
			try {
				const response = await fetch(
					`/api/search?q=${encodeURIComponent(trimmed)}&per_page=${SEARCH_PER_PAGE}`,
					{ signal: controller.signal },
				)
				const data = await response.json()
				const hits: PaletteResult[] = (data?.result?.hits ?? [])
					.map(hitToResult)
					.filter(Boolean)
				setResults(hits)
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'AbortError')) {
					setResults([])
				}
			} finally {
				if (!controller.signal.aborted) setIsSearching(false)
			}
		}, SEARCH_DEBOUNCE_MS)
		return () => {
			controller.abort()
			clearTimeout(timeout)
		}
	}, [query])

	const isQuerying = query.trim().length > 0
	const items: PaletteResult[] = isQuerying
		? results
		: CURATED_DEFAULTS.map((item) => ({ ...item, id: item.href }))

	const trackAndClose = (
		item: Pick<PaletteResult, 'title' | 'href' | 'type'>,
		via: 'result' | 'promo',
	) => {
		track('search_palette_result_selected', {
			title: item.title,
			href: item.href,
			type: item.type,
			query: query.trim() || undefined,
			via,
		})
		onOpenChange(false)
	}

	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPortal>
				<DialogOverlay className="bg-black/60" />
				<DialogPrimitive.Content
					className={cn(
						'bg-background fixed z-50 flex flex-col overflow-hidden border shadow-lg outline-none',
						// Desktop: 540px, horizontally centered, anchored near the top so
						// the dialog doesn't jump vertically as result counts change.
						'sm:left-1/2 sm:top-[18%] sm:w-full sm:max-w-[540px] sm:-translate-x-1/2',
						// Mobile: full-screen overlay.
						'max-sm:inset-0',
						'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-150',
					)}
				>
					<DialogPrimitive.Title className="sr-only">
						Search AI Hero
					</DialogPrimitive.Title>
					<Command shouldFilter={false} className="rounded-none bg-background">
						<div className="flex items-center">
							<div className="min-w-0 flex-1">
								<CommandInput
									value={query}
									onValueChange={setQuery}
									placeholder="Search posts, skills, courses…"
									autoFocus
								/>
							</div>
							{/* Mobile replaces the esc hint with an explicit Cancel. */}
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								className="text-muted-foreground hover:text-foreground border-b px-4 py-3 text-sm sm:hidden"
							>
								Cancel
							</button>
						</div>
						<CommandList className="max-h-none flex-1 p-1 sm:max-h-[320px]">
							<CommandEmpty>
								{isQuerying && !isSearching
									? 'No results — try different words.'
									: 'Searching…'}
							</CommandEmpty>
							{items.map((item) => {
								const Icon = iconForType(item.type)
								return (
									<CommandItem
										key={item.id}
										// Unique value keeps cmdk selection stable across
										// duplicate titles; first item is auto-selected.
										value={`${item.title} ${item.href}`}
										onSelect={() => {
											// Keyboard ⏎ — same destination as the anchor.
											trackAndClose(item, 'result')
											router.push(item.href)
										}}
										// cmdk's data-[selected] tracks both hover and keyboard
										// position; bg-muted matches the nav pill affordance and
										// reads clearly in both themes (bg-accent was too subtle).
										className="data-[selected=true]:bg-muted data-[selected=true]:text-foreground rounded-none p-0"
									>
										{/* Real anchor: status-bar URL, cmd/middle-click,
										    long-press context menu all work. */}
										<Link
											href={item.href}
											prefetch={false}
											tabIndex={-1}
											onClick={() => trackAndClose(item, 'result')}
											className="flex w-full items-center gap-2 px-2 py-3"
										>
											<Icon
												aria-hidden
												className="text-muted-foreground size-4 shrink-0"
											/>
											<span className="truncate">{item.title}</span>
										</Link>
									</CommandItem>
								)
							})}
						</CommandList>
						{/* Fixed footer: the promo persists while typing — results
						    scroll above it, they never push it out. */}
						{promo && (
							<Link
								href={promo.href}
								prefetch={false}
								onClick={() =>
									trackAndClose(
										{
											title: promo.message,
											href: promo.href,
											type: 'cohort',
										},
										'promo',
									)
								}
								className="group focus-visible:ring-ring flex w-full items-center gap-2 border-t bg-emerald-500/10 px-4 py-2.5 text-left text-sm text-emerald-800 transition-colors hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset dark:text-emerald-200"
							>
								{promo.label && (
									<span className="inline-flex shrink-0 items-center rounded-full bg-emerald-600 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-white">
										{promo.label}
									</span>
								)}
								<span className="truncate font-medium tracking-tight">
									{promo.message}
								</span>
								<ArrowRight
									aria-hidden
									className="ml-auto size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
								/>
							</Link>
						)}
						<div className="text-muted-foreground hidden items-center gap-4 border-t px-4 py-2 text-xs sm:flex">
							<span>
								<kbd className="font-mono">↑↓</kbd> navigate
							</span>
							<span>
								<kbd className="font-mono">⏎</kbd> open
							</span>
							<span>
								<kbd className="font-mono">esc</kbd> close
							</span>
						</div>
					</Command>
				</DialogPrimitive.Content>
			</DialogPortal>
		</DialogPrimitive.Root>
	)
}
