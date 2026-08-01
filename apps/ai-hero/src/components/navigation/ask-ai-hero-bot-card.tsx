'use client'

import * as React from 'react'
import Image from 'next/image'
import { Sparkles } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { TYPE } from '@/components/landing/type'

import { AskAIHeroBot } from './ask-ai-hero-bot'
import { CURATED_SUGGESTIONS, GOAL_SECTIONS } from './goal-sections-data'

/**
 * The Map's bot entry point, as a card: title, one line of copy, one gold
 * button. It sits at the foot of the sidebar on desktop and under the question
 * grid on mobile (the sidebar is desktop-only, and the bot is the answer for a
 * reader who none of the four questions fits).
 *
 * Data comes straight from `goal-sections-data` rather than from props: that
 * module is pure config with no server imports, and the card is mounted in the
 * sidebar, which knows nothing about the page it flanks.
 */

/** Every goal-section item slug — the bot's Map-linked boost set. */
const BOOST_SLUGS = GOAL_SECTIONS.flatMap((section) =>
	section.items.map((item) => item.slugOrId),
)

export function AskAIHeroBotCard({
	className,
	wide = false,
}: {
	className?: string
	/**
	 * The in-page presentation, for the Map's content column.
	 *
	 * The default card is drawn for a 232px rail: 14px title, 12.5px copy, a
	 * full-width 36px button. Dropped into a 1070px column that same card reads
	 * as a sidebar widget someone left in the page — either stretched thin or
	 * marooned at `max-w-[380px]`. `wide` gives it the shape the column wants:
	 * one row from 900px up, type at the page's own sizes, and a button sized
	 * to its label instead of to the container.
	 */
	wide?: boolean
}) {
	const [open, setOpen] = React.useState(false)

	return (
		<div
			className={cn(
				'border-border bg-card flex flex-col gap-1.5 rounded-md border p-4',
				wide &&
					'desk:flex-row desk:items-center gap-4 rounded-xl p-6 desk:gap-6 sm:p-8',
				className,
			)}
		>
			{wide && (
				/* The bot, not a Sparkles glyph. This card is the one place the
				   site offers a *character* to talk to, so it shows who is
				   answering — a generic AI sparkle says "machine feature". Bare
				   rather than in a tinted tile: the render has its own silhouette,
				   and a gold plate behind it just fights it. */
				<span className="flex w-16 shrink-0 items-center justify-center">
					{/* The source render is 400×483 — portrait, not square — so the
					    intrinsic ratio is kept and only the height is pinned. */}
					<Image
						src="https://res.cloudinary.com/total-typescript/image/upload/v1785574229/aihero-bot_2x.png"
						alt=""
						width={53}
						height={64}
						className="h-16 w-auto"
					/>
				</span>
			)}
			<div className={cn('flex flex-col gap-1.5', wide && 'flex-1 gap-2')}>
				<p className={cn(TYPE.cardTitle, !wide && 'text-[14px]')}>
					Not sure where to start?
				</p>
				<p
					className={cn(
						TYPE.metaProse,
						'text-muted-foreground',
						wide ? 'text-balance' : 'text-[12.5px]',
					)}
				>
					Ask the bot. It knows every article, video and skill on the site.
				</p>
			</div>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={cn(
					TYPE.meta,
					'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-[9px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
					wide &&
						'mt-0 h-11 w-full shrink-0 px-6 desk:w-auto',
				)}
			>
				<Sparkles aria-hidden className={cn('size-4 shrink-0', wide && 'desk:hidden')} />
				Ask AIHero Bot
			</button>

			<AskAIHeroBot
				open={open}
				onOpenChange={setOpen}
				suggestions={CURATED_SUGGESTIONS}
				boostSlugs={BOOST_SLUGS}
			/>
		</div>
	)
}
