import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { SKILLS_INSTALL_CHANNELS } from '@/lib/skills-content'
import { ArrowUpRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { InstallCommand } from './install-command'

export function SkillsInstallOptions({ className }: { className?: string }) {
	return (
		<section aria-label="Skill installation options" className={className}>
			<p className={cn(TYPE.micro, 'mb-3 text-[color:var(--ah-fg-label)]')}>
				Get the skills
			</p>
			<div className="border-border bg-border grid gap-px overflow-hidden rounded-lg border">
				{SKILLS_INSTALL_CHANNELS.map((channel) => (
					<div
						key={channel.id}
						className={cn(
							'flex min-w-0 flex-col p-4',
							channel.variant === 'primary' ? 'bg-background' : 'bg-muted/55',
						)}
					>
						<div className="mb-2.5 flex items-center gap-3">
							<p className={cn(TYPE.cardTitle, 'text-foreground')}>
								{channel.label}
							</p>
							<span
								className={cn(
									TYPE.micro,
									'bg-foreground/[0.06] ml-auto rounded-[4px] px-2 py-1 text-[color:var(--ah-fg-label)]',
								)}
							>
								{channel.mode}
							</span>
						</div>
						<p
							className={cn(
								TYPE.metaProse,
								'mb-4 text-[color:var(--ah-fg-muted)]',
							)}
						>
							{channel.description}
						</p>
						<InstallCommand
							command={channel.command}
							label={`${channel.label} install command`}
							className="mt-auto"
						/>
						<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
							<span
								className={cn(TYPE.metaSm, 'text-[color:var(--ah-fg-subtle)]')}
							>
								{channel.updateLabel}
							</span>
							{'updateCommand' in channel ? (
								<code
									className={cn(
										TYPE.command,
										'bg-foreground/[0.055] rounded-[4px] px-1.5 py-0.5 text-foreground/80',
									)}
								>
									{channel.updateCommand}
								</code>
							) : null}
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
				))}
			</div>
		</section>
	)
}
