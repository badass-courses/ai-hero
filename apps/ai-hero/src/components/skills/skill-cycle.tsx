'use client'

/**
 * SkillCycle — the interactive 7-phase skill cycle diagram, shared by the
 * /skills landing (W2) and the homepage (W4). Spec: w2-skills-pages §4.
 *
 * Pure client presentation: all data arrives serialized via props from a
 * server component (`getSkillEntries()` in `src/lib/skills-query.ts`). No
 * fetching inside.
 *
 * W2 embedding (/skills landing, hover-synced with a sibling catalog):
 *
 * ```tsx
 * // page.tsx (server)
 * const entries = await getSkillEntries()
 * // ...
 * <SkillCycleSection entries={entries} /> // client section below
 *
 * // client section
 * <SkillCycleHoverProvider>
 *   <SkillCycle skills={entries} size="landing" />
 *   <SkillCatalog skills={entries} /> // consumes useSkillCycleHover()
 * </SkillCycleHoverProvider>
 * ```
 *
 * W4 embedding (homepage MDX, standalone — a thin server wrapper fetches
 * entries and renders the client component, so the MDX map stays `<SkillCycle />`):
 *
 * ```tsx
 * // src/components/skills/skill-cycle-server.tsx (W4 builds this wrapper)
 * const entries = await getSkillEntries()
 * return (
 *   <SkillCycle
 *     skills={entries}
 *     size="homepage"
 *     ctaHref="/skills"
 *     ctaLabel="See all skills"
 *   />
 * )
 * ```
 *
 * Utility skills (phase 99) are automatically split out of the ring into the
 * tinted 3-column strip; passing them via `utilitySkills` works too. The
 * strip only renders at `size="landing"`.
 *
 * Hover state resolution order: controlled props (`hoveredSlug`/`onHoverSlug`)
 * → `SkillCycleHoverProvider` context → internal `useState` fallback. The
 * "active phase" is derived from the hovered skill's phase; hover/focus is a
 * visual highlight only — every node is a real link (skill URLs are flat,
 * e.g. `/skills-grill-me`).
 */

import * as React from 'react'
import Link from 'next/link'
import {
	SKILL_PHASE_UTILITY_NUMBER,
	type SkillEntry,
} from '@/lib/skills-shared'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@coursebuilder/utils/cn'

import { useSkillCycleHover } from './skill-cycle-context'

const MotionLink = motion.create(Link)

/** DESIGN.md rule 14: ease-out-quart, one-directional reveals. */
const EASE_OUT_QUART = [0.22, 1, 0.36, 1] as const

export type SkillCycleProps = {
	/**
	 * Skill entries in cycle order (list position), from `getSkillEntries()`.
	 * Utility entries (phase 99) are split out of the ring automatically.
	 */
	skills: SkillEntry[]
	/** Utility skills for the tinted 3-column strip (landing size only). */
	utilitySkills?: SkillEntry[]
	/** 'landing' = full diagram + taglines + utility strip. 'homepage' = compact, no utility row. */
	size?: 'landing' | 'homepage'
	/** Controlled hovered-skill slug. Omit to use context/internal state. */
	hoveredSlug?: string | null
	/** Controlled hover change handler; fires with null on leave/blur. */
	onHoverSlug?: (slug: string | null) => void
	/** Optional trailing CTA link (answers W4's "See all skills →" seam). */
	ctaHref?: string
	/** Label for the trailing CTA link; defaults to 'See all skills'. */
	ctaLabel?: string
	className?: string
}

type PhaseNode = {
	key: string
	/** Phase number, or null for skills without a phase tag (rendered last). */
	number: number | null
	/** Display name, e.g. 'Idea'. */
	name: string
	skills: SkillEntry[]
}

function isUtility(entry: SkillEntry): boolean {
	return entry.phase?.number === SKILL_PHASE_UTILITY_NUMBER
}

/** Group core entries into phase nodes, preserving cycle (position) order. */
function buildPhaseNodes(entries: SkillEntry[]): PhaseNode[] {
	const byPhase = new Map<number, PhaseNode>()
	const unphased: SkillEntry[] = []

	for (const entry of entries) {
		if (!entry.phase) {
			unphased.push(entry)
			continue
		}
		const existing = byPhase.get(entry.phase.number)
		if (existing) {
			existing.skills.push(entry)
		} else {
			byPhase.set(entry.phase.number, {
				key: `phase-${entry.phase.number}`,
				number: entry.phase.number,
				name: entry.phase.name,
				skills: [entry],
			})
		}
	}

	const nodes = [...byPhase.values()].sort(
		(a, b) => (a.number ?? 0) - (b.number ?? 0),
	)
	if (unphased.length > 0) {
		nodes.push({
			key: 'phase-none',
			number: null,
			name: 'More skills',
			skills: unphased,
		})
	}
	return nodes
}

export function SkillCycle({
	skills,
	utilitySkills,
	size = 'landing',
	hoveredSlug: hoveredSlugProp,
	onHoverSlug,
	ctaHref,
	ctaLabel = 'See all skills',
	className,
}: SkillCycleProps) {
	const context = useSkillCycleHover()
	const [internalSlug, setInternalSlug] = React.useState<string | null>(null)

	// Controlled props → shared context → internal state.
	const isControlled = hoveredSlugProp !== undefined || onHoverSlug !== undefined
	const hoveredSlug = isControlled
		? (hoveredSlugProp ?? null)
		: (context?.hoveredSlug ?? internalSlug)
	const setHoveredSlug = React.useCallback(
		(slug: string | null) => {
			onHoverSlug?.(slug)
			if (!isControlled) {
				if (context) context.setHoveredSlug(slug)
				else setInternalSlug(slug)
			}
		},
		[onHoverSlug, isControlled, context],
	)

	const coreEntries = skills.filter((entry) => !isUtility(entry))
	const utilityEntries = [
		...skills.filter(isUtility),
		...(utilitySkills ?? []),
	]
	const nodes = buildPhaseNodes(coreEntries)

	const activePhaseKey =
		hoveredSlug === null
			? null
			: (nodes.find((node) =>
					node.skills.some((entry) => entry.slug === hoveredSlug),
				)?.key ?? null)

	if (nodes.length === 0) return null

	// Rectangular ring: top row left-to-right, bottom row right-to-left, plus
	// a decorative "repeat" cell closing the loop bottom-left.
	const columns = Math.max(2, Math.ceil((nodes.length + 1) / 2))
	const topNodes = nodes.slice(0, columns)
	const bottomNodes = nodes.slice(columns)
	// Bottom row visual columns, right-to-left: last column = first remaining phase.
	const bottomFillerCount = Math.max(0, columns - 1 - bottomNodes.length)

	return (
		<nav
			aria-label="The skill cycle"
			className={cn('w-full', className)}
			onKeyDown={handleArrowKeys}
		>
			{/* Desktop ring */}
			<div
				className="border-border bg-border hidden gap-px border-y md:grid"
				style={{
					gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
				}}
			>
				{topNodes.map((node, index) => (
					<PhaseCell
						key={node.key}
						node={node}
						size={size}
						arrow={index === topNodes.length - 1 ? 'down' : 'right'}
						isActive={node.key === activePhaseKey}
						setHoveredSlug={setHoveredSlug}
						style={{ gridRow: 1, gridColumn: index + 1 }}
					/>
				))}
				{bottomNodes.map((node, index) => (
					<PhaseCell
						key={node.key}
						node={node}
						size={size}
						arrow="left"
						isActive={node.key === activePhaseKey}
						setHoveredSlug={setHoveredSlug}
						style={{ gridRow: 2, gridColumn: columns - index }}
					/>
				))}
				{Array.from({ length: bottomFillerCount }).map((_, index) => (
					<div
						key={`filler-${index}`}
						aria-hidden="true"
						className="bg-background"
						style={{ gridRow: 2, gridColumn: 2 + index }}
					/>
				))}
				{bottomNodes.length > 0 ? (
					<RepeatCell style={{ gridRow: 2, gridColumn: 1 }} />
				) : null}
			</div>

			{/* Mobile: vertical stack in cycle order */}
			<div className="border-border bg-border grid grid-cols-1 gap-px border-y md:hidden">
				{nodes.map((node, index) => (
					<PhaseCell
						key={node.key}
						node={node}
						size={size}
						arrow={index === nodes.length - 1 ? 'repeat' : 'down-mobile'}
						isActive={node.key === activePhaseKey}
						setHoveredSlug={setHoveredSlug}
					/>
				))}
			</div>

			{size === 'landing' && utilityEntries.length > 0 ? (
				<UtilityStrip
					entries={utilityEntries}
					hoveredSlug={hoveredSlug}
					setHoveredSlug={setHoveredSlug}
				/>
			) : null}

			{ctaHref ? (
				<div className="border-b">
					<Link
						href={ctaHref}
						className="focus-visible:ring-ring group flex items-center justify-between gap-4 px-6 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:px-8"
					>
						<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60 transition-opacity group-hover:opacity-100">
							{ctaLabel}
						</span>
						<span aria-hidden="true" className="font-mono text-sm opacity-60">
							→
						</span>
					</Link>
				</div>
			) : null}
		</nav>
	)
}

/**
 * Arrow-key navigation between skill links, wrapping around the cycle.
 * Operates on the visible links inside the grid the event fired in, in DOM
 * (= cycle) order, so it works for both the desktop ring and mobile stack.
 */
function handleArrowKeys(event: React.KeyboardEvent<HTMLElement>) {
	const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
	const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
	if (!forward && !backward) return

	const target = event.target as HTMLElement
	if (!target.hasAttribute('data-skill-link')) return

	const links = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>('[data-skill-link]'),
	).filter((el) => el.offsetParent !== null)
	const index = links.indexOf(target)
	if (index === -1 || links.length === 0) return

	event.preventDefault()
	const nextIndex =
		(index + (forward ? 1 : -1) + links.length) % links.length
	links[nextIndex]?.focus()
}

function PhaseCell({
	node,
	size,
	arrow,
	isActive,
	setHoveredSlug,
	style,
}: {
	node: PhaseNode
	size: 'landing' | 'homepage'
	arrow: 'right' | 'down' | 'left' | 'down-mobile' | 'repeat'
	isActive: boolean
	setHoveredSlug: (slug: string | null) => void
	style?: React.CSSProperties
}) {
	const firstSlug = node.skills[0]?.slug ?? null

	return (
		<div
			role="group"
			aria-label={
				node.number === null ? node.name : `Phase ${node.number}: ${node.name}`
			}
			style={style}
			onMouseEnter={() => setHoveredSlug(firstSlug)}
			onMouseLeave={() => setHoveredSlug(null)}
			className={cn(
				'bg-background relative flex flex-col transition-colors duration-300',
				size === 'landing' ? 'gap-3 px-6 py-6 sm:px-8' : 'gap-2 px-5 py-4',
				isActive && 'bg-muted/60',
			)}
		>
			<div className="flex items-baseline justify-between gap-3">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					{node.number === null ? node.name : `Phase ${node.number}`}
				</span>
				<span aria-hidden="true" className="font-mono text-sm opacity-40">
					{arrow === 'right' && '→'}
					{arrow === 'down' && '↓'}
					{arrow === 'left' && '←'}
					{arrow === 'down-mobile' && '↓'}
					{arrow === 'repeat' && '↺'}
				</span>
			</div>
			{node.number !== null ? (
				<h3
					className={cn(
						'text-balance font-semibold leading-tight tracking-tight',
						size === 'landing' ? 'text-xl sm:text-2xl' : 'text-lg',
					)}
				>
					{node.name}
				</h3>
			) : null}
			<ul className="flex flex-col gap-1">
				{node.skills.map((entry) => (
					<li key={entry.id}>
						<SkillLink
							entry={entry}
							showTagline={size === 'landing'}
							setHoveredSlug={setHoveredSlug}
						/>
					</li>
				))}
			</ul>
		</div>
	)
}

function SkillLink({
	entry,
	showTagline,
	setHoveredSlug,
}: {
	entry: SkillEntry
	showTagline: boolean
	setHoveredSlug: (slug: string | null) => void
}) {
	const shouldReduceMotion = useReducedMotion()

	return (
		<MotionLink
			// Skill URLs stay flat at the site root (settled decision).
			href={`/${entry.slug}`}
			data-skill-link
			onMouseEnter={() => setHoveredSlug(entry.slug)}
			onFocus={() => setHoveredSlug(entry.slug)}
			onBlur={() => setHoveredSlug(null)}
			initial="initial"
			whileHover="hover"
			whileFocus="hover"
			animate="initial"
			className="focus-visible:ring-ring group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
		>
			<motion.span
				variants={
					shouldReduceMotion
						? undefined
						: {
								initial: { x: 0 },
								hover: {
									x: 2,
									transition: { duration: 0.3, ease: EASE_OUT_QUART },
								},
							}
				}
				className="block text-base font-medium leading-snug tracking-tight opacity-80 transition-opacity group-hover:opacity-100"
			>
				{entry.title}
			</motion.span>
			{showTagline && entry.tagline ? (
				<span className="mt-0.5 line-clamp-2 block text-sm leading-snug opacity-60">
					{entry.tagline}
				</span>
			) : null}
		</MotionLink>
	)
}

/** Decorative loop-closer cell: the cycle repeats. Not a phase, not focusable. */
function RepeatCell({ style }: { style?: React.CSSProperties }) {
	return (
		<div
			aria-hidden="true"
			style={style}
			className="bg-background flex items-center gap-3 px-6 py-6 sm:px-8"
		>
			<span className="font-mono text-sm opacity-40">↺</span>
			<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-40">
				and repeat
			</span>
		</div>
	)
}

/** Utility skills: distinct 3-column strip on a muted tint (landing only). */
function UtilityStrip({
	entries,
	hoveredSlug,
	setHoveredSlug,
}: {
	entries: SkillEntry[]
	hoveredSlug: string | null
	setHoveredSlug: (slug: string | null) => void
}) {
	const remainder = entries.length % 3
	const fillerCount = remainder === 0 ? 0 : 3 - remainder

	return (
		<div className="border-b">
			<div className="px-6 pb-3 pt-6 sm:px-8">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Utility skills
				</span>
			</div>
			<div className="border-border bg-border grid grid-cols-1 gap-px border-t sm:grid-cols-3">
				{entries.map((entry) => (
					<div
						key={entry.id}
						className={cn(
							'bg-muted flex flex-col gap-1 px-6 py-5 transition-colors duration-300 sm:px-8',
							hoveredSlug === entry.slug && 'bg-muted/60',
						)}
					>
						<SkillLink
							entry={entry}
							showTagline
							setHoveredSlug={setHoveredSlug}
						/>
					</div>
				))}
				{Array.from({ length: fillerCount }).map((_, index) => (
					<div
						key={`utility-filler-${index}`}
						aria-hidden="true"
						className="bg-muted hidden sm:block"
					/>
				))}
			</div>
		</div>
	)
}
