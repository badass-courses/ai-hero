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
	FileText,
	GraduationCap,
	Map as MapIcon,
	Play,
} from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { useCohortOffer } from '../navigation/nav-cta-context'
import { FEATURED_PROMO, type Promo } from '../navigation/promo-config'
import { NAV_ICONS, SkillsIcon } from '../navigation/sidebar/nav-icons'
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
 * keyboard ⏎ routes through the same href. The promo row resolves from the
 * root layout's `NavCtaContext` (site-wide override → next cohort → static
 * fallback), so it costs nothing and is right in the first paint.
 *
 * Loaded via `next/dynamic` from `Navigation`, which also owns the ⌘K binding —
 * this component is not mounted until the first time it opens.
 *
 * Desktop: 540px, centered on a dimmed backdrop. Mobile: full-screen overlay
 * with a Cancel button instead of the esc hint.
 */

/** One palette result row — curated defaults and live hits share this shape. */
type PaletteResult = PaletteItem & { id: string }

const TYPE_ICONS: Record<PaletteItemType, React.ComponentType<any>> = {
	// `/learn` and `/skills` resolve to the sidebar's own glyphs via NAV_ICONS
	// below; these two are the fallback for hits that share the type but not the
	// destination (a skill POST, say, rather than the skill set).
	map: MapIcon,
	skill: SkillsIcon,
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

/** Trailing slash + case stripped, so `/Skills/` matches `/skills`. */
function normalizeHref(href: string): string {
	const path = href.split(/[?#]/)[0]?.replace(/\/+$/, '') || ''
	return (path === '' ? '/' : path).toLowerCase()
}

/**
 * The row's glyph. A destination the hub sidebar also lists (Map, Skills, Open
 * source) takes the SIDEBAR's icon, not a lucide stand-in for its type: the two
 * surfaces name the same places one keystroke apart, and drawing /skills as a
 * cog here and as the skill glyph in the rail made them look like two different
 * destinations. Everything else falls back to the type icon.
 */
function iconForItem(item: { type: string; href: string }) {
	const navIcon = NAV_ICONS[normalizeHref(item.href)]
	if (navIcon) return navIcon
	return TYPE_ICONS[item.type as PaletteItemType] ?? FileText
}

/**
 * A keycap in the palette's hint row. Bare mono glyphs read as punctuation next
 * to their labels ("↑↓ navigate" looked like a typo); a bordered cap says
 * "this is a key you press". Square-ish 4px corners and the mono micro-size are
 * the badge step from DESIGN.md — a key is that scale of object, not a control,
 * so it does not take the 9px control radius. `min-w` keeps single glyphs from
 * collapsing into narrower caps than "esc".
 */
function Key({ children }: { children: React.ReactNode }) {
	return (
		<kbd className="border-input text-foreground/70 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border px-1 font-mono text-[10px] leading-none">
			{children}
		</kbd>
	)
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
	'skill',
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
	// A failed search is not an empty one. Without this, a 500 from
	// `/api/search` — or a body that isn't the shape we expect — rendered the
	// same "No results — try different words." as a genuine miss, so a reader
	// retyped their query against a service that was never going to answer.
	// `AskAIHeroBot` draws the same distinction; the two search surfaces should
	// fail the same way.
	const [hasError, setHasError] = React.useState(false)
	// The promo row, resolved with no network call at all.
	//
	// It used to `fetch('/api/palette-promo')` on every open — a round-trip, and
	// a visible swap from the static fallback to the real row — for a cohort the
	// ROOT LAYOUT has already resolved and put in `NavCtaContext`. Same
	// `getUpcomingCohort` underneath, so the answer is identical; it is simply
	// already here, correct in the first paint.
	const cohortOffer = useCohortOffer()
	const promo = React.useMemo<Promo | null>(() => {
		if (FEATURED_PROMO) return FEATURED_PROMO
		// Only a purchasable cohort earns the row. Between cohorts the nav still
		// carries a waitlist CTA, but the palette's promo is a date-led
		// announcement — "starts soon" is the whole point of it.
		if (cohortOffer?.kind === 'enroll') {
			const starts = cohortOffer.startsAt
				? ` — starts ${new Intl.DateTimeFormat('en-US', {
						month: 'long',
						day: 'numeric',
					}).format(new Date(cohortOffer.startsAt))}`
				: ''
			return {
				label: 'Cohort',
				message: `${cohortOffer.title}${starts}`,
				href: cohortOffer.href,
			}
		}
		return PALETTE_PROMO
	}, [cohortOffer])
	// Set on a row's pointerdown, cleared by any keydown in the palette (see the
	// row's `onSelect`). Cleared on keydown rather than after the click so a
	// press that drags off the row and never becomes a click can't leave the
	// flag set and swallow the next ⏎.
	const pointerSelectRef = React.useRef(false)

	// ⌘K is owned by `Navigation`, not by this component: the palette is
	// `next/dynamic` and not mounted until its first open, so a listener in here
	// could never have fired the shortcut that opens it.

	// Reset per open so a reopened palette starts at the curated defaults.
	React.useEffect(() => {
		if (!open) {
			setQuery('')
			setResults([])
			setIsSearching(false)
			setHasError(false)
		}
	}, [open])

	// Debounced server search; server ranks, cmdk does not re-filter.
	React.useEffect(() => {
		const trimmed = query.trim()
		if (!trimmed) {
			setResults([])
			setIsSearching(false)
			setHasError(false)
			return
		}
		setIsSearching(true)
		setHasError(false)
		const controller = new AbortController()
		const timeout = setTimeout(async () => {
			try {
				const response = await fetch(
					`/api/search?q=${encodeURIComponent(trimmed)}&per_page=${SEARCH_PER_PAGE}`,
					{ signal: controller.signal },
				)
				if (!response.ok) throw new Error(`search failed: ${response.status}`)
				const data = await response.json()
				// The predicate, not a bare `filter(Boolean)`: `data` is `any`, so
				// nothing here would have complained about the nulls `hitToResult`
				// returns for unlinkable hits — they would simply have arrived as
				// rows with no title and no href.
				const hits: PaletteResult[] = (data?.result?.hits ?? [])
					.map(hitToResult)
					.filter((item: PaletteResult | null): item is PaletteResult =>
						Boolean(item),
					)
				setResults(hits)
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'AbortError')) {
					setResults([])
					setHasError(true)
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
	// Hoisted rather than rebuilt per render: without the memo every keystroke
	// re-allocated the whole curated list, including on the frames where it is
	// not even the thing being displayed.
	const defaults = React.useMemo<PaletteResult[]>(
		() => CURATED_DEFAULTS.map((item) => ({ ...item, id: item.href })),
		[],
	)
	const items: PaletteResult[] = isQuerying ? results : defaults

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
						// 12px stated literally: `rounded-xl` resolves through `--radius`
						// and lands on 14px here, off the spec's 4/6/9/11/12 scale.
						// Desktop panel only —
						// mobile is `inset-0` full-screen, where a radius would round
						// the corners of the viewport. `overflow-hidden` above is what
						// clips the input and the rows to it.
						'sm:rounded-[12px]',
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
					<Command
						shouldFilter={false}
						className="bg-background rounded-none"
						onKeyDown={() => {
							pointerSelectRef.current = false
						}}
					>
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
								{hasError
									? 'Search is unavailable right now. Try again in a moment.'
									: isQuerying && !isSearching
										? 'No results — try different words.'
										: 'Searching…'}
							</CommandEmpty>
							{items.map((item) => {
								const Icon = iconForItem(item)
								return (
									<CommandItem
										key={item.id}
										// Unique value keeps cmdk selection stable across
										// duplicate titles; first item is auto-selected.
										value={`${item.title} ${item.href}`}
										// cmdk's Item attaches its own `onClick` that calls
										// `onSelect`, so a mouse click on the anchor below BUBBLES
										// into this handler as well: unguarded, one click tracked
										// `search_palette_result_selected` twice and fired a
										// `router.push` on top of the anchor's own navigation
										// (a duplicate history entry, so Back appeared broken).
										// The anchor owns the mouse; this owns the keyboard.
										onPointerDown={() => {
											pointerSelectRef.current = true
										}}
										onSelect={() => {
											if (pointerSelectRef.current) return
											// Keyboard ⏎ — same destination as the anchor.
											trackAndClose(item, 'result')
											router.push(item.href)
										}}
										// cmdk's data-[selected] tracks both hover and keyboard
										// position. NOT `bg-muted`: the design refresh retoned the dark
										// palette, and `--muted` (#0d0d0c) now sits two values off
										// `--background` (#0b0b0b) — the cursor was invisible in the theme
										// most people read in. `--secondary` is the app's raised-surface step
										// (white/.07 dark, ink/.06 light) and it separates from the ground in
										// both.
										className="data-[selected=true]:bg-secondary data-[selected=true]:text-foreground rounded-none p-0"
									>
										{/* Real anchor: status-bar URL, cmd/middle-click,
										    long-press context menu all work. */}
										<Link
											href={item.href}
											// Default `auto`: partial prefetch in the viewport, full
											// on hover. Not `true` — the list re-renders per keystroke
											// and full-fetching 8 speculative results each time is
											// waste. Not `false` either: in Next 16 that kills hover
											// prefetch too, and these rows are about to be clicked.
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
							<span className="flex items-center gap-1.5">
								<Key>↑</Key>
								<Key>↓</Key>
								navigate
							</span>
							<span className="flex items-center gap-1.5">
								<Key>⏎</Key>
								open
							</span>
							<span className="flex items-center gap-1.5">
								<Key>esc</Key>
								close
							</span>
						</div>
					</Command>
				</DialogPrimitive.Content>
			</DialogPortal>
		</DialogPrimitive.Root>
	)
}
