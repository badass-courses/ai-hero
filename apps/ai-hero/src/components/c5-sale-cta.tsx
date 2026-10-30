import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { BADGE_SOLID, TYPE } from './landing/type'
import {
	C5_IMAGE,
	C5_PITCH,
	C5_TEAM_HREF,
	C5_TITLE,
} from './navigation/promo-config'

/** Price-free copy shared by the temporary acquisition surfaces. */
export function C5SaleCta({ forTeams = false }: { forTeams?: boolean }) {
	const href = forTeams ? C5_TEAM_HREF : '/s/c5-site-cta'

	return (
		<aside className="not-prose border-border bg-muted my-8 border-y">
			<div className="grid gap-6 px-[18px] py-10 sm:grid-cols-[minmax(0,300px)_1fr] sm:items-center sm:gap-10 sm:px-11">
				{/* The artwork repeats the button's link, so it stays out of the tab
				    order and the accessibility tree. */}
				<Link href={href} tabIndex={-1} aria-hidden="true" className="block">
					<Image
						src={C5_IMAGE}
						width={600}
						height={320}
						alt=""
						sizes="(min-width: 640px) 300px, 100vw"
						className="border-border w-full rounded-[11px] border"
					/>
				</Link>
				<div className="flex flex-col items-start gap-3">
					<span className={cn(TYPE.badge, BADGE_SOLID)}>Enrollment open</span>
					<h2 className={cn(TYPE.panelTitle, 'text-balance')}>{C5_TITLE}</h2>
					<p className={cn(TYPE.metaProse, 'text-muted-foreground max-w-prose text-balance')}>
						{C5_PITCH}
					</p>
					<p className={TYPE.metaMark}>
						Two weeks with Matt Pocock · Live office hours
					</p>
					<Link
						href={href}
						className={cn(
							TYPE.meta,
							'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover group mt-2 inline-flex h-[46px] items-center gap-2 whitespace-nowrap rounded-[9px] px-6 font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
						)}
					>
						{forTeams ? 'Join with your team' : 'Join the cohort'}
						<ArrowRight
							aria-hidden="true"
							className="size-4 transition-transform group-hover:translate-x-0.5"
						/>
					</Link>
				</div>
			</div>
		</aside>
	)
}
