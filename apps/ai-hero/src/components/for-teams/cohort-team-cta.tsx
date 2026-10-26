import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { C5_TEAM_HREF } from '@/components/navigation/promo-config'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'

import { cn } from '@coursebuilder/ui/utils/cn'

import { FOR_TEAMS_INNER } from './for-teams-page'

/** Crash Course team credit copy. The caller owns the shared C5 sale gate. */
export function CohortTeamCta() {
	return (
		<section aria-labelledby="team-cohort-title" className="bg-muted border-b">
			<div className={FOR_TEAMS_INNER}>
				<h2
					id="team-cohort-title"
					className={cn(TYPE.heading, 'max-w-[32ch] text-balance')}
				>
					Take your team further: Software Factories for Real Engineers
				</h2>
				<p className={cn(TYPE.lead, 'text-foreground/80 mt-5 max-w-[70ch]')}>
					Matt Pocock’s next AI Hero cohort starts Monday Nov 9.
					It builds on the Crash Course.
				</p>
				<p className={cn(TYPE.body, 'mt-4 max-w-[70ch]')}>
					Teams that bought Crash Course seats get credit for what they paid,
					one seat for each cohort seat.
				</p>
				<div className="mt-8 flex flex-wrap gap-3">
					<Link
						href={C5_TEAM_HREF}
						className={cn(WORKSHOP_CTA_BUTTON, 'inline-flex items-center')}
					>
						See the cohort
					</Link>
					<a
						href="#contact"
						className={cn(
							TYPE.meta,
							'border-input hover:bg-secondary focus-visible:ring-ring inline-flex min-h-[46px] items-center justify-center rounded-[9px] border px-5 font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
						)}
					>
						Get a team quote
					</a>
				</div>
			</div>
		</section>
	)
}
