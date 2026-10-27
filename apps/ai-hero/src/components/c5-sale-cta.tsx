import Link from 'next/link'

import { TYPE } from './landing/type'
import { C5_TEAM_HREF, C5_TITLE } from './navigation/promo-config'

/** Price-free copy shared by the temporary acquisition surfaces. */
export function C5SaleCta({ forTeams = false }: { forTeams?: boolean }) {
	return (
		<aside className="not-prose border-border bg-muted my-8 flex flex-col gap-4 border-y px-[18px] py-12 sm:px-11">
			<p className={`${TYPE.groupLabel} text-primary`}>Enrollment is open</p>
			<h2 className={`${TYPE.panelTitle} text-balance`}>{C5_TITLE}</h2>
			<Link
				href={forTeams ? C5_TEAM_HREF : '/s/c5-site-cta'}
				className={`${TYPE.meta} bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover inline-flex min-h-11 w-fit items-center rounded-[9px] px-5 py-3 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`}
			>
				{forTeams ? 'Join with your team' : 'Join the cohort'}
			</Link>
		</aside>
	)
}
