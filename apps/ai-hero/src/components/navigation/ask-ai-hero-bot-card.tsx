'use client'

import * as React from 'react'
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

export function AskAIHeroBotCard({ className }: { className?: string }) {
	const [open, setOpen] = React.useState(false)

	return (
		<div
			className={cn(
				'border-border bg-card flex flex-col gap-1.5 rounded-md border p-4',
				className,
			)}
		>
			<p className={cn(TYPE.cardTitle, 'text-[14px]')}>
				Not sure where to start?
			</p>
			<p className={cn(TYPE.metaProse, 'text-muted-foreground text-[12.5px]')}>
				Ask the bot. It knows every article, video and skill on the site.
			</p>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={cn(
					TYPE.meta,
					'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-[9px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
				)}
			>
				<Sparkles aria-hidden className="size-4 shrink-0" />
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
