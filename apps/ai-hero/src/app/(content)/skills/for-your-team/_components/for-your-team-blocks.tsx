import * as React from 'react'
import Link from 'next/link'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import { Download, Presentation } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The blocks `/skills/for-your-team` is assembled from.
 *
 * The page is a CMS `page` row, so everything a reader sees is authored in MDX
 * and Matt can edit it without a deploy. These components exist so that the
 * things he CANNOT get wrong from an editor — the gutter, the hairlines, the
 * type scale, both themes — are not expressible in the body. He writes copy and
 * props; the layout is here.
 *
 * ## Why this is not the standard video-post layout
 *
 * A post page is read by one person who arrived from a list and is working
 * through a course. This page is read by two people with different questions,
 * and the order of the page is the answer to both:
 *
 * 1. A team member who was **sent the link**. They know nothing, they are one
 *    of six people told to watch something, and the only thing they need is to
 *    press play. So the head above the player is two lines: what this is, and
 *    the fact that it works alone or on a screen together. Then the player,
 *    full width, immediately.
 * 2. The **champion** deciding whether to spend forty minutes of their team's
 *    week on it. They need the contents, not prose, and they need it to scan in
 *    one pass. So the section under the player is a running order, not a grid
 *    of feature cards.
 *
 * Everything after those two is an exit: run it yourself with the slides, or
 * hear when the crash course opens. Nothing else earns a band on this page.
 *
 * Every block is a full-bleed `<section>` with no horizontal padding of its
 * own, per DESIGN rule 1: the container owns the side borders and the inner
 * content pads to the 18/44px gutter. Separators come from the article wrapper
 * in `for-your-team-body.tsx`, not from the blocks, so sections can be
 * reordered in the CMS without anyone touching a border.
 */

/** The inner pad every block shares. Rule 1 and rule 3, in one place. */
const INNER = 'px-[18px] py-12 sm:px-11 md:py-[52px]'

/**
 * The head and the player: the whole reason the link gets forwarded.
 *
 * The title sits ABOVE the video, and tight against it. A cold arrival needs to
 * know what they clicked before they commit to pressing play, and one screen
 * has to carry both — so the head is `TYPE.title` rather than a landing hero's
 * `displayLanding`, and it is capped at a short measure so it never pushes the
 * player under the fold on a laptop.
 *
 * The player is full bleed, meeting the container's `border-x`, so it takes no
 * radius (rule 12: objects on the page get a radius, the page's own structure
 * does not). It is the largest thing on the route by a wide margin, which is
 * the point.
 *
 * The media slot takes children so the body can put a real `<Video>` in it:
 *
 *   <TeamHero h1="…" lead="…">
 *     <Video resourceId="…" />
 *   </TeamHero>
 *
 * With no children it draws the striped placeholder (rule 6) instead of
 * collapsing, and names the CMS row that fills it (`cmsPageId`, injected by the
 * body renderer, never authored in MDX). Whoever sees the empty slot is usually
 * the person who has to fix it, and the fix is "edit this row". It appears only
 * while the slot is empty, so it cannot outlive the problem it explains.
 */
export function TeamHero({
	h1,
	lead,
	cmsPageId,
	children,
}: {
	h1: string
	lead?: string
	cmsPageId?: string
	children?: React.ReactNode
}) {
	const hasVideo = React.Children.count(children) > 0

	return (
		<section>
			<div className="flex flex-col gap-4 px-[18px] pb-8 pt-12 sm:px-11 md:pb-10 md:pt-[52px]">
				<h1 className={cn(TYPE.title, 'max-w-[22ch] text-balance font-sans')}>
					{h1}
				</h1>
				{lead && (
					<p className={cn(TYPE.lead, 'text-foreground/80 max-w-[65ch]')}>
						{lead}
					</p>
				)}
			</div>
			{/* Full bleed, sharp, and the biggest object on the page. */}
			<div className="border-border border-t">
				{hasVideo ? (
					<div className="[&_>div]:max-w-none [&_>div]:rounded-none">
						{children}
					</div>
				) : (
					<div className="bg-stripes flex aspect-video w-full flex-col items-center justify-center gap-2.5">
						<span className={cn(TYPE.badge, BADGE_NEUTRAL)}>
							Video coming soon
						</span>
						{cmsPageId && (
							<span
								className={cn(
									TYPE.metaMark,
									'bg-background/80 rounded-sm px-2 py-1',
								)}
							>
								Add it to {cmsPageId}
							</span>
						)}
					</div>
				)}
			</div>
		</section>
	)
}

/**
 * The running order: what is actually in the video, in the order it happens.
 *
 * One column of rows, not a grid of cards. The grid version of this read as a
 * spec sheet — seven equal boxes scanned in a Z, with an orphan eighth cell to
 * square the last row — and a spec sheet is the wrong genre for "here is what
 * your team will sit through". A single column is read the way the video is
 * watched: top to bottom, in order, and the numerals mean something because of
 * it.
 *
 * Rules between rows use `--ah-line-soft`, the "dividers inside a list" weight
 * (DESIGN rule 2), so they read as one object rather than as seven cards
 * stacked.
 */
export function LearnList({
	heading,
	intro,
	bare = false,
	children,
}: {
	heading: string
	intro?: string
	/** Rendered inside `TeamSplit`, which owns the section and the gutter. */
	bare?: boolean
	children: React.ReactNode
}) {
	const items = React.Children.toArray(children)

	const content = (
		<div className={cn(bare ? '' : INNER, 'flex flex-col gap-8 md:gap-10')}>
				<div className="flex flex-col gap-4">
					<h2
						className={cn(TYPE.heading, 'max-w-[20ch] text-balance font-sans')}
					>
						{heading}
					</h2>
					{intro && (
						<p className={cn(TYPE.lead, 'text-foreground/80 max-w-[65ch]')}>
							{intro}
						</p>
					)}
				</div>
				{/* `border-t` only. The `divide-y` already rules between rows, so a
					    closing `border-b` drew a second line under the last item at a
					    heavier weight than the ones above it, which read as the list
					    being cut off rather than ending. The list ends on its last
					    row. */}
					<ol className="border-border divide-[color:var(--ah-line-soft)] divide-y border-t">
					{items.map((item, i) => (
						<li key={i} className="flex items-baseline gap-5 py-5 sm:gap-7">
							<span className={cn(TYPE.navNum, 'text-primary shrink-0')}>
								{String(i + 1).padStart(2, '0')}
							</span>
							<span className={cn(TYPE.body, 'text-foreground/85 max-w-[70ch]')}>
								{item}
							</span>
						</li>
					))}
				</ol>
		</div>
	)

	return bare ? content : <section>{content}</section>
}

/** One row of `LearnList`. Carries no styling: the list sets the type. */
export function LearnItem({ children }: { children: React.ReactNode }) {
	return <>{children}</>
}

/**
 * The do-it-yourself exit: take the deck and run the session yourself.
 *
 * **Not a card.** It was one, and a bordered box sitting in a section is the
 * visual grammar of an advertisement: readers have learned to skip anything
 * fenced off that way, and this is the one block on the page addressed
 * directly to the person who decides whether the session happens at all. It
 * now sits on the page like everything else and earns attention by position
 * and by the glyph, not by a border.
 *
 * Vertical, because it lives in the narrow column beside the running order.
 * The icon is doing real work: this is the only block offering a *different
 * medium* from the video above it, and a slide glyph says that faster than the
 * heading does.
 *
 * `href` is a prop so Matt can point it at the deck once it is uploaded,
 * without touching this component.
 *
 * **Without an `href` the block renders in a pending state**: the button is
 * replaced by the same self-destructing pointer the empty video slot uses,
 * naming the CMS row to edit. Deliberately NOT a placeholder link. A `href="#"`
 * renders as a real, working-looking control that silently does nothing, which
 * is the worst of the three options: a missing section is invisible, a
 * marked-pending one is a to-do list, and a dead link is a broken promise the
 * reader blames the page for. Both unfinished things on this route now say the
 * same sentence in the same voice.
 */
export function SlidesCard({
	heading = 'Prefer to present it yourself?',
	body,
	href,
	label = 'Download the slides',
	cmsPageId,
	bare = false,
}: {
	heading?: string
	body?: string
	href?: string
	label?: string
	cmsPageId?: string
	/** Rendered inside `TeamSplit`, which owns the section and the gutter. */
	bare?: boolean
}) {
	const content = (
		<div
			className={cn(
				bare ? '' : INNER,
				'flex flex-col items-start gap-4 desk:sticky desk:top-28',
			)}
		>
			<span
				aria-hidden
				className="border-input text-primary flex h-12 w-12 items-center justify-center rounded-sm border"
			>
				<Presentation className="h-5 w-5" />
			</span>
			<div className="flex flex-col gap-2">
				<h3 className={cn(TYPE.subhead, 'text-balance font-sans')}>{heading}</h3>
				{body && (
					<p className={cn(TYPE.body, 'text-foreground/75 max-w-[42ch]')}>
						{body}
					</p>
				)}
			</div>
			{href ? (
				<Link
					href={href}
					className={cn(
						TYPE.meta,
						'border-input hover:bg-foreground/5 focus-visible:ring-ring inline-flex h-12 w-fit items-center justify-center gap-2 rounded-[9px] border px-6 font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
					)}
				>
					<Download className="h-4 w-4" aria-hidden />
					{label}
				</Link>
			) : (
				<p
					className={cn(
						TYPE.metaMark,
						'border-input inline-flex w-fit items-center gap-2 rounded-sm border border-dashed px-3 py-2',
					)}
				>
					<Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
					<span>
						{cmsPageId
							? `Slides coming soon. Add the URL to ${cmsPageId}`
							: 'Slides coming soon'}
					</span>
				</p>
			)}
		</div>
	)

	return bare ? content : <section>{content}</section>
}

/**
 * Two blocks side by side once there is room for them: the running order and
 * the slides aside.
 *
 * Stacked, these were two full-width bands making the same point at two
 * different volumes — "here is what is in it" followed immediately by "or run
 * it yourself" — and the second inherited a whole band of its own for four
 * lines of text. Beside each other they read as what they are: the contents,
 * and a note in the margin about another way to use them.
 *
 * `1.4fr / 1fr` is the documented editorial ratio (DESIGN rule 4), not a new
 * one: the list is the substance and the aside is genuinely subordinate, so it
 * is the 1.4 default rather than the balanced 1.1 the hero and the close use.
 * `desk:` is the spec's one structural breakpoint (rule 19) — below 900px this
 * is a stack, and the aside falls where it did before.
 *
 * Children are cloned with `bare`, so this section owns the gutter and the
 * vertical rhythm exactly once. Without that each child would pad itself
 * inside an already-padded grid cell.
 */
export function TeamSplit({ children }: { children: React.ReactNode }) {
	const [main, aside] = React.Children.toArray(children)

	const bare = (node: React.ReactNode) =>
		React.isValidElement(node)
			? React.cloneElement(node as React.ReactElement<any>, { bare: true })
			: node

	// One child is a supported state, not a broken one. The slides block is
	// optional — Matt may delete it from the body, and it removes itself when it
	// has no URL — and a two-column grid with nothing in the second cell would
	// leave the running order squeezed into 1.4fr with a dead column beside it.
	// With nothing to sit next to, the list simply gets the section back.
	if (!aside) {
		return (
			<section>
				<div className={INNER}>{bare(main)}</div>
			</section>
		)
	}

	return (
		<section>
			<div
				className={cn(
					INNER,
					'grid grid-cols-1 gap-10 desk:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] desk:items-start desk:gap-16',
				)}
			>
				<div>{bare(main)}</div>
				<div>{bare(aside)}</div>
			</div>
		</section>
	)
}

/**
 * The closing band: the promise, and the ask, as one thing.
 *
 * ## Three layouts were wrong before this one
 *
 * **Stacked full-width** drifted left and inherited the page's dead right
 * margin, so the ask read as an aside at the moment it needed to read as the
 * point. **A two-column split** fixed the margin but broke the section in
 * half: the heading argued on the left while an unrelated-looking panel sat on
 * the right, and the left column ran out of words long before the right ran
 * out of height. **A bordered panel** inside either of those was worst of all,
 * because a box in a section is the visual grammar of an advertisement and
 * readers skip advertisements.
 *
 * So: one column, one heading, one argument, and then the ask directly beneath
 * it, with the form wide enough to fill the shell. Nothing is fenced off,
 * nothing competes for the title, and the last thing on the page is a row of
 * fields rather than a border.
 *
 * ## Centred, and only here
 *
 * The rest of the route is flush left, because everything above this point is
 * material you read: a running order, an aside, a lead under a headline. Left
 * alignment gives all of it one rag to scan down.
 *
 * The close is not material to read, it is a single decision to make, and it
 * is the one block on the page with nothing after it. Centring it does two
 * things left alignment cannot: it removes the dead right margin that made the
 * ask read as an aside, and the change of axis is itself the signal that the
 * page has ended. Used once, on the last block, that is punctuation. Used on
 * every section it would be the thing that makes a page feel like a template.
 *
 * Measures stay capped (20ch heading, 60ch body) and centred with `mx-auto`.
 * Centred text without a capped measure is the failure mode: ragged on both
 * edges and unreadable past about 70 characters.
 */
/**
 * The closing band's paragraph, when it needs emphasis inside it.
 *
 * `TeamClose`'s `body` prop is a plain string, which is right for copy with no
 * internal structure and useless the moment one clause has to carry more
 * weight than the rest. This takes MDX children instead, so the body can be
 * written with `**bold**` in the editor and Matt never touches a class name.
 *
 * The emphasised run goes to full `text-foreground` as well as 600 weight: at
 * the paragraph's 80% ink a bold span reads as slightly darker grey rather
 * than as emphasis, which is the usual reason bold "does not show up".
 */
export function TeamCloseBody({ children }: { children: React.ReactNode }) {
	return (
		<div
			className={cn(
				TYPE.lead,
				'text-foreground/80 mx-auto max-w-[60ch] text-pretty [&_strong]:text-foreground [&_strong]:font-semibold',
			)}
		>
			{children}
		</div>
	)
}

export function TeamClose({
	heading,
	body,
	media,
	children,
}: {
	heading: string
	body?: string
	/**
	 * Rendered above the heading. Injected by the body renderer, not authored in
	 * MDX: what the closing band illustrates is the product the page promotes,
	 * which the page already knows.
	 */
	media?: React.ReactNode
	children?: React.ReactNode
}) {
	return (
		<section className="bg-muted">
			<div
				className={cn(
					INNER,
					// Tighter than the page's other blocks, deliberately. Elsewhere a
					// gap separates independent things; here the cover, the heading,
					// the paragraph and the fields are ONE statement read top to
					// bottom, and at `gap-8/10` they drifted into four unrelated
					// items floating in a band. The one generous gap left is the one
					// before the fields, which is where the reading stops and the
					// doing starts.
					'flex flex-col items-center gap-6 text-center',
				)}
			>
				{media}
				<div className="flex flex-col items-center gap-3">
					<h2
						className={cn(
							TYPE.heading,
							'mx-auto max-w-[20ch] text-balance font-sans',
						)}
					>
						{heading}
					</h2>
					{body && (
						<p
							className={cn(
								TYPE.lead,
								'text-foreground/80 mx-auto max-w-[60ch] text-pretty',
							)}
						>
							{body}
						</p>
					)}
				</div>
				{children}
			</div>
		</section>
	)
}
