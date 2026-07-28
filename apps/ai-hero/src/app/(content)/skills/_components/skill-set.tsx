import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { invocationName } from '@/components/skills/skill-meta'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

export type SkillSetItem = {
	slug: string
	title: string
	description?: string
}

export type SkillSetGroup = {
	id: string
	/** Null for skills sitting loose in the list, outside any section. */
	title: string | null
	description?: string
	skills: SkillSetItem[]
}

/**
 * THE SKILL SET (`Skills Page.dc.html` § THE SKILL SET).
 *
 * The catalog, grouped by when you reach for a skill rather than alphabetically
 * or by phase tag. Groups, their order, their one-line descriptions and their
 * members are all the CMS list's `section` resources — nothing here is
 * hardcoded, including the numbering, which is the group's position in the
 * list.
 *
 * A skill is drawn as the thing it actually is: a slash command, then what it
 * does. The command sits in a fixed 196px column so twenty-one of them form a
 * scannable left edge instead of a ragged one.
 */
export function SkillSet({
	groups,
	skillCount,
}: {
	groups: SkillSetGroup[]
	skillCount: number
}) {
	if (groups.length === 0) return null

	// Only titled groups are numbered: a loose run has no name to number.
	let groupNumber = 0

	return (
		<section
			aria-labelledby="skill-set-heading"
			className="border-border border-b bg-[color:var(--ah-band)]"
		>
			<div className="px-8 pb-[52px] pt-12 sm:px-11">
				<div className="mb-[34px] flex flex-col gap-5 md:flex-row md:items-end md:gap-5">
					<div>
						<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
							The skill set
						</p>
						<h2
							id="skill-set-heading"
							className={cn(TYPE.heading, 'mt-3.5 text-balance')}
						>
							{skillCount} skills, grouped by when you reach for them
						</h2>
					</div>
					<p
						className={cn(
							TYPE.metaSm,
							'text-[color:var(--ah-fg-subtle)] md:ml-auto md:shrink-0',
						)}
					>
						Ordered: most people start with the main flow
					</p>
				</div>

				<div className="flex max-w-[960px] flex-col gap-[34px]">
					{groups.map((group) => {
						if (group.title) groupNumber += 1
						return (
							<div key={group.id}>
								{group.title ? (
									<div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
										<span
											className={cn(
												TYPE.command,
												'text-[color:var(--ah-fg-faint)]',
											)}
										>
											{String(groupNumber).padStart(2, '0')}
										</span>
										<h3 className={TYPE.subhead}>{group.title}</h3>
										{group.description ? (
											<p
												className={cn(
													TYPE.metaProse,
													'text-[color:var(--ah-fg-subtle)]',
												)}
											>
												{group.description}
											</p>
										) : null}
									</div>
								) : null}
								<ul className="flex flex-col gap-2.5">
									{group.skills.map((skill) => (
										<li key={skill.slug}>
											<SkillRow {...skill} />
										</li>
									))}
								</ul>
							</div>
						)
					})}
				</div>
			</div>
		</section>
	)
}

function SkillRow({ slug, title, description }: SkillSetItem) {
	return (
		<Link
			href={`/${slug}`}
			className="border-input bg-card hover:border-foreground/25 focus-visible:ring-ring group flex flex-col items-start gap-3 rounded-md border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:flex-row sm:items-center sm:gap-[18px] sm:py-3 sm:pl-3 sm:pr-4"
		>
			<span
				className={cn(
					TYPE.command,
					'border-input bg-muted block w-full truncate rounded-sm border px-[11px] py-[9px] text-[color:var(--ah-fg-body)] sm:w-[196px] sm:flex-none',
				)}
			>
				/{invocationName(slug)}
			</span>
			<span className="min-w-0">
				<span className={cn(TYPE.cardTitle, 'mb-1 block')}>{title}</span>
				{description ? (
					<span
						className={cn(
							TYPE.metaProse,
							'block text-[color:var(--ah-fg-muted)]',
						)}
					>
						{description}
					</span>
				) : null}
			</span>
			<span
				aria-hidden
				className="border-input ml-auto hidden size-8 flex-none items-center justify-center rounded-full border text-[color:var(--ah-fg-subtle)] transition-colors group-hover:text-[color:var(--ah-fg-body)] sm:flex"
			>
				<ArrowRight className="ease-out-quart size-3.5 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" />
			</span>
		</Link>
	)
}
