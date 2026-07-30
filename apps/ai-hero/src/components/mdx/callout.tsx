import React from 'react'
import { TYPE } from '@/components/landing/type'
import { Asterisk } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Cross-promo intent for a Callout. Selects the default icon per intent and
 * MARKS this callout as a promo placement for the auto-insert suppression scan
 * (W1 §2.2) — the remark plugin keys on Callout nodes carrying an `intent`
 * attribute. A bare `<Callout>` (no intent) is an informational note and must
 * never suppress auto-insertion.
 */
export type CalloutIntent = 'skill' | 'course' | 'resource'

/**
 * One mark for every callout: an asterisk.
 *
 * It replaces a literal-object set — wrench for a skill, mortarboard for a
 * course, open book for a resource — which drew three different pictures for
 * what is always the same gesture: the page stopping to point sideways. The
 * asterisk is the typographic mark for exactly that, so it says "aside" without
 * illustrating the destination, and it does not date the way a mortarboard does.
 *
 * NOTE: this deliberately gives up the per-intent shape differentiation DESIGN
 * asks for. That rule is about not encoding meaning in colour alone, and here
 * nothing is encoded at all — every callout reads as an aside, and the copy
 * names the destination. No `intent` is used anywhere in `src`; the three
 * shapes were distinguishing cases the reader never saw side by side.
 *
 * `strokeWidth` is eased off because an asterisk at 20px is six strokes meeting
 * at a point, and at lucide's default weight that junction fills in.
 */
function CalloutMark() {
	return <Asterisk className="size-5 shrink-0" strokeWidth={1.75} />
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
				{/* Same `.ah-prose-p` override as the icon-rail variant below — its
				    trailing 20px landed inside the padded box and read as the notice
				    being bottom-heavy. */}
				<div className="ah-callout-body prose prose-sm sm:prose-base dark:prose-invert prose-p:text-foreground text-foreground text-pretty text-base leading-[1.55]">
					{children}
				</div>
			</div>
		)
	}

	// Explicit `icon` prop still wins — a caller that wants its own glyph keeps
	// it. Everything else gets the asterisk, intent or not.
	const resolvedIcon = icon ?? <CalloutMark />

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
				// `my-6`, matching the `kind` variant. At `my-3` the callout cleared
				// its neighbours by 12px while the paragraphs around it are 20px
				// apart, so a block that is meant to interrupt the read sat tighter
				// to the body than the body sits to itself.
				'not-prose bg-card shadow-md/3 my-6 flex items-stretch gap-4 rounded-xl border',
				className,
			)}
		>
			<div className="text-primary bg-stripes flex shrink-0 items-center justify-center overflow-hidden rounded-l-xl border-r px-5 py-4">
				{resolvedIcon}
			</div>
			{/* Centred in its own stretched cell. The row is `items-stretch` so the
			    striped icon rail runs the full height; without this the copy then
			    sits hard against the top of that box whenever the rail is the taller
			    of the two, which reads as misaligned against a centred glyph.

			    `ah-callout-body` is not decoration, same as `ah-testimonial`: MDX
			    paragraphs arrive wearing the UNLAYERED `.ah-prose-p`
			    (compile-mdx.tsx), whose `margin: 0 0 20px` beats every Tailwind
			    utility regardless of specificity, `prose-p:my-0` included. That
			    trailing 20px sat inside the centred box, so a one-line callout put
			    its text 10px above the glyph it is aligned to. */}
			<div className="ah-callout-body prose prose-sm sm:prose-base dark:prose-invert flex flex-col justify-center py-4 pr-5">
				{children}
			</div>
		</div>
	)
}
