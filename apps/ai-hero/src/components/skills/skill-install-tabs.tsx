'use client'

import * as React from 'react'
import Link from 'next/link'
import { InstallCommand } from '@/app/(content)/skills/_components/install-command'
import { TYPE } from '@/components/landing/type'
import { SKILLS_INSTALL_CHANNELS } from '@/lib/skills-content'
import { ArrowUpRight } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

/**
 * The two install channels as tabs, for the skill-page action band.
 *
 * `/skills` shows both channels stacked, because there the rail has the height
 * for it and a reader arriving cold benefits from seeing that a plugin route
 * exists at all. Inside a skill page the band is one row of a longer article
 * and two stacked commands is a wall, so the same two channels become tabs: the
 * default is true for everyone, and the Claude Code plugin is one click away
 * for the readers it applies to.
 *
 * Reads `SKILLS_INSTALL_CHANNELS`, the same constant the hero and the GitHub
 * section use, so a changed command or URL lands everywhere at once. `tabLabel`
 * exists because the channels' own `label` ("Install the skills") is true of
 * both and says nothing about which tab you are picking.
 */
export function SkillInstallTabs({
	/** The `/command` this skill answers to, named under the install row. */
	command,
	className,
}: {
	command: string
	className?: string
}) {
	const [primary] = SKILLS_INSTALL_CHANNELS

	return (
		<Tabs
			defaultValue={primary.id}
			className={cn('gap-3.5', className)}
		>
			{/* Small: this is a switch between two forms of one instruction, not
			    navigation. `h-8` and 12px labels keep it under the `subhead` above
			    it, and `w-fit` stops a two-item strip stretching across the cell
			    like a segmented control with something to prove.

			    Labels only, no agent marks. The marks earn their place in the hero,
			    where they answer "does this apply to me?" before any copy does. In
			    a 32px strip they would be a 20px box and a 12px glyph fighting the
			    label, for a control that is already two words wide. */}
			<TabsList className="h-8 w-fit rounded-[9px] p-[3px]">
				{SKILLS_INSTALL_CHANNELS.map((channel) => (
					<TabsTrigger
						key={channel.id}
						value={channel.id}
						className={cn(TYPE.metaSm, 'rounded-[6px] px-2.5 font-medium')}
					>
						{channel.tabLabel}
					</TabsTrigger>
				))}
			</TabsList>

			{SKILLS_INSTALL_CHANNELS.map((channel) => (
				<TabsContent key={channel.id} value={channel.id} className="min-w-0">
					<InstallCommand
						command={channel.command}
						label={`${channel.label} install command`}
					/>
					<p
						className={cn(
							TYPE.metaProse,
							'mt-3 text-[color:var(--ah-fg-muted)]',
						)}
					>
						Installs the whole set. Then type{' '}
						<code
							className={cn(
								TYPE.command,
								'text-foreground bg-foreground/[0.055] border-border/70 rounded-[4px] border px-1.5 py-0.5',
							)}
						>
							/{command}
						</code>{' '}
						in your coding agent.
					</p>
					<div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
				</TabsContent>
			))}
		</Tabs>
	)
}
