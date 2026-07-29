import React from 'react'
import { TYPE } from '@/components/landing/type'
import { GraduationCap, Wrench, BookOpen } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Cross-promo intent for a Callout. Selects the default icon per intent and
 * MARKS this callout as a promo placement for the auto-insert suppression scan
 * (W1 §2.2) — the remark plugin keys on Callout nodes carrying an `intent`
 * attribute. A bare `<Callout>` (no intent) is an informational note and must
 * never suppress auto-insertion.
 */
export type CalloutIntent = 'skill' | 'course' | 'resource'

/** Per-intent default icon — shape-differentiated (not color-only), keeps the
 * existing `text-primary` icon treatment (no new hues per DESIGN.md). */
const intentIcon: Record<CalloutIntent, React.ReactNode> = {
	skill: <Wrench className="size-4 shrink-0" />,
	course: <GraduationCap className="size-4 shrink-0" />,
	resource: <BookOpen className="size-4 shrink-0" />,
}

function CalloutIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.5"
				d="M12.31 3h-.62c-2.436 0-3.654 0-4.65.553-.997.552-1.588 1.555-2.771 3.562l-.59 1C2.56 10.014 2 10.963 2 12s.56 1.986 1.68 3.885l.589 1c1.183 2.007 1.774 3.01 2.77 3.563.997.552 2.215.552 4.65.552h.622c2.435 0 3.653 0 4.65-.552.996-.553 1.587-1.556 2.77-3.563l.59-1C21.44 13.986 22 13.037 22 12s-.56-1.986-1.68-3.885l-.589-1c-1.183-2.007-1.774-3.01-2.77-3.562C15.963 3 14.745 3 12.31 3Z"
			/>
		</svg>
	)
}

/**
 * The redesign spec's `.ah-callout` shapes (`aihero.css`). A `kind` is a
 * different *object* from an `intent`: `intent` says "this is a cross-promo,
 * suppress auto-insertion around it" and keeps the icon-rail card, while `kind`
 * is the spec's flat accent-washed notice — the "update from Matt" band above a
 * skill body. They are deliberately not merged: existing `intent` callers must
 * keep the card they have.
 */
export type CalloutKind = 'update' | 'note'

/** Eyebrow copy per kind. `update` is Matt speaking; `note` is the page. */
/**
 * What a promo callout is called in the ToC rail — a verb for the row, not the
 * callout's own copy, which is a sentence and would wrap to three lines in a
 * 232px column.
 */
const intentTocLabel: Record<CalloutIntent, string> = {
	skill: 'Try the skill',
	course: 'Go deeper',
	resource: 'Get the resource',
}

const kindEyebrow: Record<CalloutKind, string> = {
	update: 'Update from Matt',
	note: 'Note',
}

export function Callout({
	children,
	className,
	icon,
	intent,
	kind,
	eyebrow,
}: {
	children: React.ReactNode
	className?: string
	icon?: React.ReactNode
	/** Cross-promo intent. Selects the default icon per intent and MARKS this
	 *  callout as a promo placement for the auto-insert suppression scan (W1 §2.2). */
	intent?: CalloutIntent
	/** Spec `.ah-callout` variant: an accent-washed notice with a mono eyebrow
	 *  and no icon rail. Mutually exclusive with `intent` in practice. */
	kind?: CalloutKind
	/** Overrides the eyebrow copy for a `kind` callout. Ignored without `kind`. */
	eyebrow?: string
}) {
	if (kind) {
		return (
			<div
				className={cn(
					// 3px accent LEFT border: the one place DESIGN's side-stripe ban
					// yields, because the spec names it. Everything else is a hairline.
					// Order matters: the all-sides accent line is set first so the
					// 3px left rule can override just that edge (tailwind-merge
					// drops an earlier border-l-color under a later border-color).
					'not-prose border-[color:var(--ah-accent-line)] border-l-primary my-6 rounded-md border border-l-[3px] bg-[color:var(--ah-accent-wash)] px-5 py-[18px]',
					className,
				)}
			>
				<p
					// Gold at full strength would out-shout the body it labels; in
					// light `--primary` is ink, which needs no easing off.
					className={cn(TYPE.micro, 'text-primary dark:text-primary/85 mb-2')}
				>
					{eyebrow ?? kindEyebrow[kind]}
				</p>
				<div className="prose prose-sm sm:prose-base dark:prose-invert prose-p:my-0 prose-p:text-foreground text-foreground text-pretty text-base leading-[1.55]">
					{children}
				</div>
			</div>
		)
	}

	// Explicit `icon` prop wins; otherwise the intent default; otherwise the
	// generic informational glyph (bare `<Callout>` contract unchanged).
	const resolvedIcon =
		icon ??
		(intent ? intentIcon[intent] : <CalloutIcon className="size-4 shrink-0" />)

	return (
		<div
			// Cross-promo placements announce themselves to the article's ToC rail
			// (`useCtaLandmarks` in `post-toc-rail.tsx`) rather than being wired
			// into it from the page: the auto-inserted line and any hand-placed
			// one are both invisible to the server that renders the rail. Bare
			// informational callouts carry nothing, same contract as the
			// suppression scan.
			{...(intent
				? { 'data-toc-cta': 'callout', 'data-toc-label': intentTocLabel[intent] }
				: {})}
			className={cn(
				'not-prose bg-card shadow-md/3 my-3 flex items-stretch gap-4 rounded-xl border',
				className,
			)}
		>
			<div className="text-primary bg-stripes flex shrink-0 items-center justify-center overflow-hidden rounded-l-xl border-r px-5 py-4">
				{resolvedIcon}
			</div>
			{/* Centred in its own stretched cell. The row is `items-stretch` so the
			    striped icon rail runs the full height; without this the copy then
			    sits hard against the top of that box whenever the rail is the taller
			    of the two, which reads as misaligned against a centred glyph. */}
			<div className="prose prose-sm sm:prose-base dark:prose-invert prose-p:my-0 flex flex-col justify-center py-4 pr-5">
				{children}
			</div>
		</div>
	)
}
