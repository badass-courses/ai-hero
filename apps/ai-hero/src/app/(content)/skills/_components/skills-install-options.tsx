import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import {
	SKILLS_INSTALL_CHANNELS,
	SKILLS_RAIL_FOOTER,
} from '@/lib/skills-content'
import { ArrowUpRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import {
	AgentMarkCycle,
	AgentMarkStatic,
} from '@/components/skills/agent-marks'

import { InstallCommand } from './install-command'

/**
 * The two install channels, as the hero's rail.
 *
 * One rule governs what is left after Amy's chrome note: **grey means "this is
 * code."** The striped panel, the outer bordered grid, the per-cell greys, the
 * mode badges (`RECOMMENDED` / `PLUGIN`) and the boxed `npx skills update` chip
 * are all gone. What remains is a heading, a sentence, and a filled command row
 * — the only filled surface in the hero.
 *
 * The mode badges went because they repeated the heading: the first channel is
 * the recommended one *because it is first*. The update chip went because a
 * second code container inside a meta line reads as a second command; the
 * command stays inline at one ink step up instead.
 *
 * Both channels stay on every width except a phone. Demoting the Claude Code
 * plugin was the tempting cut, but it is the shortest path for the readers most
 * likely to install. Under 560px of container it collapses to a single line —
 * two commands stacked on a 390px screen is a wall.
 *
 * ## Where the descriptions go
 *
 * The channel descriptions render only above 940px of hero container, the same
 * step the layout uses. Under it the rail is not a rail — it is the next block
 * down a single column — and a reader who has scrolled past the headline, the
 * lead, the stats and the signup to reach a command does not need a sentence
 * explaining that the command installs something.
 */
export function SkillsInstallOptions({
	className,
	skillCount,
}: {
	className?: string
	/** Live count of published skills in the CMS list. */
	skillCount?: number
}) {
	const [primary, ...rest] = SKILLS_INSTALL_CHANNELS

	return (
		<section
			aria-label="Skill installation options"
			className={cn('flex flex-col', className)}
		>
			{/* No "Get the skills" eyebrow: the heading directly under it says
			    "Install the skills" (gate 1 of the eyebrow rule). */}
			<Channel channel={primary} />

			{rest.map((channel) => (
				<div key={channel.id}>
					{/* One hairline between channels. There is no container around them
					    any more — a border around a border was half the chrome. */}
					<div className="border-border mt-[26px] hidden border-t pt-[26px] @[560px]:block">
						<Channel channel={channel} />
					</div>
					{'mobileLabel' in channel ? (
						<Link
							href={channel.href}
							target="_blank"
							rel="noreferrer"
							className={cn(
								TYPE.metaMark,
								'border-border hover:text-foreground focus-visible:ring-ring mt-[22px] inline-flex items-center gap-1.5 border-t pt-[22px] transition-colors focus-visible:outline-none focus-visible:ring-2 @[560px]:hidden',
							)}
						>
							{channel.mobileLabel}
							<ArrowUpRight aria-hidden className="size-3" />
						</Link>
					) : null}
				</div>
			))}

			<div className="border-border mt-[26px] border-t pt-5">
				<p className={cn(TYPE.cardTitle, 'text-foreground')}>
					{SKILLS_RAIL_FOOTER.heading}
				</p>
				{/* "Any agent" was a stat in a hairline grid at the foot of the hero
				    and "Free · open source · N skills" was the hero's eyebrow. Neither
				    is a metric: both are properties of the commands above, so they live
				    next to them, where a reader deciding whether to run one is looking. */}
				<p className={cn(TYPE.metaMark, 'mt-1.5')}>
					{[
						SKILLS_RAIL_FOOTER.agents,
						skillCount ? `${skillCount} skills` : null,
						SKILLS_RAIL_FOOTER.licence,
					]
						.filter(Boolean)
						.join(' · ')}
				</p>
			</div>
		</section>
	)
}

function Channel({
	channel,
}: {
	channel: (typeof SKILLS_INSTALL_CHANNELS)[number]
}) {
	return (
		<div className="flex min-w-0 flex-col">
			<div className="mb-2.5 flex items-center gap-2.5">
				{/* The mark says which agents this channel reaches, at the moment a
				    reader is deciding whether the command below applies to them —
				    faster than the sentence under it can. The first channel cycles the
				    whole set because it installs into any of them; the Claude Code row
				    shows one mark because it means one agent. */}
				{channel.mark === 'cycle' ? (
					<AgentMarkCycle className="text-[color:var(--ah-fg-body)]" />
				) : (
					<AgentMarkStatic
						name={channel.mark}
						className="text-[color:var(--ah-fg-body)]"
					/>
				)}
				<p className={cn(TYPE.cardTitle, 'text-foreground')}>{channel.label}</p>
			</div>
			<p
				className={cn(
					TYPE.metaProse,
					'mb-3.5 hidden text-[color:var(--ah-fg-muted)] @[940px]:block',
				)}
			>
				{channel.description}
			</p>
			<InstallCommand
				command={channel.command}
				label={`${channel.label} install command`}
			/>
			<div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
				{/* The update instruction as one plain line. The command used to sit
				    in its own boxed chip beside this label, which read as a second
				    thing to run; one ink step up says "this is the command" without a
				    second container. */}
				<span className={TYPE.metaMark}>
					{channel.updateLabel}
					{'updateCommand' in channel ? (
						<>
							{' '}
							<span className="text-[color:var(--ah-fg-body)]">
								{channel.updateCommand}
							</span>
						</>
					) : null}
				</span>
				<Link
					href={channel.href}
					target="_blank"
					rel="noreferrer"
					className={cn(
						TYPE.metaSm,
						'hover:text-foreground focus-visible:ring-ring ml-auto inline-flex items-center gap-1 text-[color:var(--ah-fg-subtle)] transition-colors focus-visible:outline-none focus-visible:ring-2',
					)}
				>
					{channel.linkLabel}
					<ArrowUpRight aria-hidden className="size-3" />
				</Link>
			</div>
		</div>
	)
}
