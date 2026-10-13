'use client'

import React, { useRef } from 'react'
import Link from 'next/link'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'
import { Contributor } from '@/components/contributor'
import { TYPE } from '@/components/landing/type'
import type { Cohort } from '@/lib/cohort'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { useInView } from 'framer-motion'
import { CheckCircle } from 'lucide-react'
import { useMeasure } from 'react-use'

import { Button, ScrollArea } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import type { CohortMobileCta } from './cohort-coming-soon'

export const CohortSidebar = ({
	children,

	cohort,
	mobileCta,
}: {
	children: React.ReactNode
	sticky?: boolean
	cohort: Cohort
	/** What the phone's bottom bar offers; it follows what this rail holds. */
	mobileCta: CohortMobileCta
}) => {
	const [sidebarRef, { height }] = useMeasure<HTMLDivElement>()
	const [windowHeight, setWindowHeight] = React.useState(0)
	const buySectionRef = useRef<HTMLDivElement>(null)
	const isInView = useInView(buySectionRef, { margin: '0px 0px 0% 0px' })

	React.useEffect(() => {
		const handleResize = () => {
			setWindowHeight(window.innerHeight)
		}
		handleResize()
		window.addEventListener('resize', handleResize)

		return () => {
			window.removeEventListener('resize', handleResize)
		}
	}, [])

	return (
		<>
			<div
				ref={buySectionRef}
				id="buy"
				className="dark:bg-muted/50 scroll-mt-15 relative flex w-full min-w-0 flex-col gap-3 border-t bg-white md:max-w-sm md:border-l lg:shrink-0 lg:border-t-0"
			>
				<div
					ref={sidebarRef}
					className={cn('', {
						'md:top-(--nav-height) md:sticky': true, // sticky && windowHeight - 63 > height,
						'': true, // scrollable
					})}
				>
					<ScrollArea className="h-full lg:max-h-[calc(100vh-var(--nav-height))] [&>[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot='scroll-area-scrollbar']]:opacity-50">
						{children}
						{!Boolean(windowHeight - 63 > height) && (
							<div className="from-card pointer-events-none absolute bottom-0 left-0 hidden h-20 w-full bg-gradient-to-t to-transparent lg:block" />
						)}
					</ScrollArea>
				</div>
			</div>

			<CohortSidebarMobile
				className={cn({
					'pointer-events-none opacity-0': isInView,
				})}
				cohort={cohort}
				cta={mobileCta}
			/>
		</>
	)
}

/**
 * The phone's way back to the rail: a bar pinned to the bottom while the rail
 * is off screen. Same object as the workshop page's bar
 * (`WorkshopSidebarMobile`): one truncated title, one line under it, and one
 * control at 44px. The line under the title is the cohort's dates, or the
 * byline for a cohort whose dates are not set yet, so the bar never stands on
 * a title alone.
 *
 * The control says what the rail holds, never more: enrollment only while
 * seats can be bought, the waitlist while they cannot, a plain status for
 * someone already on it, and the workshops for someone who owns the cohort.
 * Gold is for the two asks; the owner's control is navigation, so it is an
 * outline, as on the workshop bar.
 *
 * Every control is a link to `#buy` rather than the action itself: the rail
 * may hold a form, a price that needs a sign-in, or a survey, and the bar
 * cannot stand in for any of those.
 */
export const CohortSidebarMobile = ({
	cohort,
	className,
	cta,
}: {
	cohort: Cohort
	className?: string
	cta: CohortMobileCta
}) => {
	const { fields } = cohort
	const { startsAt, endsAt, timezone } = fields

	const { dateString: eventDateString } = formatCohortDateRange(
		startsAt,
		endsAt,
		timezone,
	)

	const handleScrollToBuy = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault()
		const buySection = document.getElementById('buy')
		buySection?.scrollIntoView({
			behavior: 'smooth',
			block: 'start',
		})
	}

	// Nothing in the rail to act on, so nothing to pin.
	if (cta === 'none') return null

	return (
		<div
			className={cn(
				'bg-background/90 backdrop-blur-xs fixed bottom-0 left-0 z-20 flex w-full items-center justify-between gap-3 border-t px-3 py-3 transition-opacity duration-300 lg:hidden',
				className,
			)}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				<h3 className="font-heading truncate text-sm font-semibold">
					{fields.title}
				</h3>
				{eventDateString ? (
					<p className={cn(TYPE.metaMark, 'truncate')}>{eventDateString}</p>
				) : (
					<Contributor className="gap-1 text-sm [&_img]:w-5" />
				)}
			</div>
			{cta === 'on-waitlist' ? (
				<p
					className={cn(
						TYPE.meta,
						'flex h-11 shrink-0 items-center gap-1.5',
					)}
				>
					<CheckCircle
						className="text-primary size-4 shrink-0"
						aria-hidden="true"
					/>
					On the waitlist
				</p>
			) : cta === 'owned' ? (
				<Button
					asChild
					variant="outline"
					className="border-border h-11 shrink-0 rounded-[9px] border bg-transparent px-4 text-sm font-medium"
				>
					<Link href="#buy" onClick={handleScrollToBuy}>
						Workshops
					</Link>
				</Button>
			) : (
				<Button
					asChild
					className={cn(WORKSHOP_CTA_BUTTON, 'h-11 shrink-0 gap-2 text-sm')}
				>
					<Link href="#buy" onClick={handleScrollToBuy}>
						{cta === 'waitlist' ? 'Join Waitlist' : 'Enroll Now'}
					</Link>
				</Button>
			)}
		</div>
	)
}
