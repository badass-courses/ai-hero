'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { cn } from '@coursebuilder/utils/cn'

import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '../ui/command'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'

/**
 * AskAIHeroBot — v1 smart search (Map page, spec §4.1).
 *
 * A page-scoped content finder co-located with the Map's anchor TOC. It is
 * deliberately search-only: a debounced `GET /api/search` (hybrid/semantic
 * Typesense) feeding a flat, icon + title result list. There is NO
 * conversational AI here — no `useChat`, no `/api/chat`, no streaming (that is
 * the explicitly-deferred v2 upgrade per the wireframe's "no conversational AI"
 * note).
 *
 * Because the results are server-ranked (and re-ranked client-side by the
 * Map-linked boost below), cmdk's own fuzzy filter is disabled
 * (`shouldFilter={false}`) — semantic hits rarely substring-match the query and
 * would otherwise be filtered out / reordered by score. This mirrors the
 * established `search-palette.tsx` (W5) pattern.
 *
 * Open state is owned by the caller (`open` / `onOpenChange`) so the page or
 * `MapToc` drives it. This component does NOT bind ⌘K — that shortcut is
 * reserved for the site-wide W5 palette and must not collide.
 */

/** One hit from `GET /api/search` (agent-envelope `result.hits[]`). */
interface SearchHit {
	id: string
	type: string
	title: string
	slug: string
	url: string
	summary?: string
}

/**
 * Hit types whose root-level `view` URL is self-contained. `lesson`/`section`
 * and friends need parent (workshop/list) context the search API doesn't
 * resolve, so their root URLs 404 — exclude them from bot results. Mirrors the
 * allowlist in `search-palette.tsx`.
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

const VIDEO_HIT_TYPES = new Set(['lesson', 'video', 'solution'])
const SKILL_HIT_TYPES = new Set(['skill', 'skill-changelog'])

/**
 * Type → emoji glyph per the wireframe (📝 article/post, 🎬 video, ⚙️ skill).
 * The search hit only carries Typesense `type` (not `postType`), so this is a
 * best-effort structural mapping; skill posts indexed as plain `post` fall back
 * to 📝, which is acceptable for the compact icon-only row.
 */
function TypeIcon({ type }: { type: string }) {
	let glyph = '📝'
	let label = 'Article'
	if (VIDEO_HIT_TYPES.has(type)) {
		glyph = '🎬'
		label = 'Video'
	} else if (SKILL_HIT_TYPES.has(type)) {
		glyph = '⚙️'
		label = 'Skill'
	}
	return (
		<span aria-label={label} role="img" className="shrink-0 text-base leading-none">
			{glyph}
		</span>
	)
}

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_PER_PAGE = 8

export interface AskAIHeroBotProps {
	/** Controlled open state — owned by the page / MapToc. */
	open: boolean
	/** Open-state setter. */
	onOpenChange: (open: boolean) => void
	/** Curated "Try asking" prompts shown before the visitor types (spec §4.1). */
	suggestions: string[]
	/**
	 * Slugs referenced by the Map's goal sections. Hits whose `slug` is in this
	 * set are stable-sorted to the top of the result list (Map-linked boost).
	 */
	boostSlugs: string[]
}

export function AskAIHeroBot({
	open,
	onOpenChange,
	suggestions,
	boostSlugs,
}: AskAIHeroBotProps) {
	const router = useRouter()
	const [query, setQuery] = React.useState('')
	const [results, setResults] = React.useState<SearchHit[]>([])
	const [isSearching, setIsSearching] = React.useState(false)
	const [hasError, setHasError] = React.useState(false)

	// Stable identity so the debounce effect doesn't re-run on every render when
	// the caller passes a fresh array literal for `boostSlugs`.
	const boostSet = React.useMemo(
		() => new Set(boostSlugs),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[boostSlugs.join('|')],
	)

	// Reset per open so a reopened bot starts at the curated suggestions.
	React.useEffect(() => {
		if (!open) {
			setQuery('')
			setResults([])
			setIsSearching(false)
			setHasError(false)
		}
	}, [open])

	// Debounced server search; stale in-flight requests are aborted. The server
	// ranks; we then stable-partition Map-linked hits to the front.
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
					`/api/search?q=${encodeURIComponent(trimmed)}&semantic=true&per_page=${SEARCH_PER_PAGE}`,
					{ signal: controller.signal },
				)
				if (!response.ok) throw new Error(`search failed: ${response.status}`)
				const data = await response.json()
				const hits: SearchHit[] = (data?.result?.hits ?? []).filter(
					(hit: SearchHit) =>
						hit?.title && hit?.url && LINKABLE_HIT_TYPES.has(hit.type),
				)
				// Map-linked boost: stable partition, preserving each bucket's
				// server order (do NOT re-rank by score within a bucket).
				const boosted = hits.filter((hit) => boostSet.has(hit.slug))
				const rest = hits.filter((hit) => !boostSet.has(hit.slug))
				setResults([...boosted, ...rest])
			} catch (error) {
				if (error instanceof DOMException && error.name === 'AbortError') return
				setResults([])
				setHasError(true)
			} finally {
				if (!controller.signal.aborted) setIsSearching(false)
			}
		}, SEARCH_DEBOUNCE_MS)
		return () => {
			controller.abort()
			clearTimeout(timeout)
		}
	}, [query, boostSet])

	const navigate = (hit: SearchHit) => {
		let href = hit.url
		try {
			href = new URL(hit.url).pathname
		} catch {
			/* hit.url already relative — use as-is */
		}
		onOpenChange(false)
		router.push(href)
	}

	const isQuerying = query.trim().length > 0

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="overflow-hidden rounded-none p-0 shadow-lg">
				<DialogTitle className="sr-only">Ask AIHero</DialogTitle>
				<Command
					shouldFilter={false}
					className="rounded-none [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3"
				>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder="Search articles, posts, skills & courses"
						autoFocus
					/>
					<CommandList className="max-h-[min(60vh,360px)]">
						<CommandEmpty>
							{hasError
								? 'Search is unavailable right now. Try again in a moment.'
								: isSearching
									? 'Searching…'
									: 'No results — try a different phrase.'}
						</CommandEmpty>

						{!isQuerying && suggestions.length > 0 && (
							<CommandGroup heading="Try asking">
								{suggestions.map((suggestion) => (
									<CommandItem
										key={suggestion}
										value={suggestion}
										onSelect={() => setQuery(suggestion)}
										className="rounded-none"
									>
										<span
											aria-hidden
											className="shrink-0 text-base leading-none opacity-70"
										>
											💬
										</span>
										<span className="truncate">{suggestion}</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}

						{isQuerying && results.length > 0 && (
							<CommandGroup>
								{results.map((hit) => (
									<CommandItem
										key={hit.id}
										value={hit.id}
										onSelect={() => navigate(hit)}
										className={cn(
											'rounded-none',
											boostSet.has(hit.slug) && 'data-[selected=false]:font-medium',
										)}
									>
										<TypeIcon type={hit.type} />
										<span className="truncate">{hit.title}</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	)
}
