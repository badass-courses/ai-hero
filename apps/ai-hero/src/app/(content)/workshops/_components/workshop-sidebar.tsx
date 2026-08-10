'use client'

import React, { useRef } from 'react'
import Link from 'next/link'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import { Contributor } from '@/components/contributor'
import config from '@/config'
import { env } from '@/env.mjs'
import { getFirstResourceSlug } from '@/lib/content-navigation'
import type { MinimalWorkshop } from '@/lib/workshops'
import { useInView } from 'framer-motion'

import { Button, ScrollArea } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	InlineBuyButton,
	type PricingComponentProps,
} from './inline-mdx-pricing'
import { useWorkshopNavigation } from './workshop-navigation-provider'
import { WORKSHOP_CTA_BUTTON } from './workshop-notify-button'
import type { WorkshopPageProps } from './workshop-page-props'

export const WorkshopSidebar = ({
	children,
	workshop,
	className,
	pricingProps,
	interestCapture = false,
	purchased = false,
}: {
	children: React.ReactNode
	workshop?: MinimalWorkshop | null
	className?: string
	pricingProps?: WorkshopPageProps
	interestCapture?: boolean
	/** The viewer owns this workshop: the mobile bar offers Continue, not Buy. */
	purchased?: boolean
}) => {
	const buySectionRef = useRef<HTMLDivElement>(null)
	const isInView = useInView(buySectionRef, { margin: '0px 0px 0% 0px' })

	// The bottom fade exists to say "there is more below" — so it has to know
	// whether that is actually true. Driven by the ScrollArea's own scroll
	// position: at (or near) the end it goes, including the trivial case where
	// everything fits and there is no scrolling at all. This replaces the old
	// window-vs-column height comparison, which could only ever say "the column
	// overflows" and kept fading out the last rows for a reader who had already
	// scrolled to them.
	const scrollRootRef = useRef<HTMLDivElement>(null)
	const [hasMoreBelow, setHasMoreBelow] = React.useState(false)

	React.useEffect(() => {
		const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
			'[data-slot="scroll-area-viewport"]',
		)
		if (!viewport) return

		const update = () => {
			setHasMoreBelow(
				viewport.scrollTop + viewport.clientHeight <
					viewport.scrollHeight - 8,
			)
		}
		update()
		viewport.addEventListener('scroll', update, { passive: true })
		const observer = new ResizeObserver(update)
		observer.observe(viewport)
		// Content grows and shrinks in place (accordion sections, resolving
		// pricing), so watch the content box too, not just the viewport.
		if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)

		return () => {
			viewport.removeEventListener('scroll', update)
			observer.disconnect()
		}
	}, [])

	return (
		<>
			<div
				ref={buySectionRef}
				id="buy"
				className={cn(
					'scroll-mt-15 relative flex h-full flex-col',
					// The waitlist state, and ONLY that state, takes the hatched
					// ground. It is the same treatment the skills course front door
					// gives its signup column (`bg-muted bg-stripes-muted`, hairline on
					// the inside edge): two columns, one of them the ask, and the hatch
					// is what marks the ask as an object resting on the page rather than
					// a panel drawn on it.
					//
					// It runs the full height of the column on purpose — the card is
					// short and the column is tall, and stopping the ground at the
					// card's own edge leaves the rest of the rail reading as a gap
					// beside the article rather than as the other half of the split.
					//
					// Every other state fills its own column edge-to-edge (see below),
					// so a ground under those would only ever be covered up.
					interestCapture && 'border-border bg-muted bg-stripes-muted lg:border-l',
					className,
				)}
			>
				{/* No padding on the SHELL, deliberately. Every state this hosts
				    reaches the column's own edges: the pricing widget is a `bg-card`
				    surface that has to fill the column to read as one, and the
				    resource list is full-bleed by design. Padding the shell
				    double-inset both — it floated the pricing card inside its own
				    column instead of filling it.

				    The waitlist card is the exception, and it is inset HERE rather
				    than by padding itself, because the inset belongs to the layout:
				    the card is an object sitting on the hatched ground above, and an
				    object that touches all four edges of its ground is not sitting on
				    it, it IS it. `empty:hidden` because the card removes itself for
				    someone already on the list — without it the padding would hold a
				    band of hatch open around nothing. */}
				{/* Sticky from `md` up, unconditionally. This used to be gated on the
				    column being shorter than the viewport, which meant the one state
				    that most needs to follow the reader — a tall pricing card — was
				    the one state that scrolled away. The `ScrollArea` below caps the
				    column at the viewport instead, so it can always stick. */}
				<div ref={scrollRootRef} className="md:top-(--nav-height) md:sticky">
					<ScrollArea className="lg:max-h-[calc(100vh-var(--nav-height))] h-full [&_[data-slot='scroll-area-scrollbar']]:opacity-50">
						{interestCapture ? (
							<div className="p-5 empty:hidden sm:p-6">{children}</div>
						) : (
							children
						)}
						{!interestCapture && hasMoreBelow && (
							<div className="from-background bg-linear-to-t pointer-events-none absolute bottom-0 left-0 hidden h-20 w-full to-transparent lg:block" />
						)}
					</ScrollArea>
				</div>
			</div>
			<WorkshopSidebarMobile
				className={cn({
					'pointer-events-none opacity-0': isInView,
				})}
				workshop={workshop}
				pricingProps={pricingProps}
				interestCapture={interestCapture}
				purchased={purchased}
			/>
		</>
	)
}

/**
 * Owner's control in the mobile bar: an outline Continue into the next
 * unfinished lesson (or the first one on a fresh start). Outline, not gold —
 * the bar's gold is reserved for the two asks (buy, get notified); resuming
 * your own course is navigation.
 */
const ContinueLearningButton = ({ moduleSlug }: { moduleSlug: string }) => {
	const workshopNavigation = useWorkshopNavigation()
	const firstLessonSlug = getFirstResourceSlug(workshopNavigation)
	const { moduleProgress } = useModuleProgress()
	const isInProgress =
		moduleProgress?.nextResource?.fields?.slug &&
		moduleProgress?.completedLessons?.length > 0

	const slug = isInProgress
		? moduleProgress?.nextResource?.fields?.slug
		: firstLessonSlug
	if (!slug) return null

	return (
		<Button
			asChild
			variant="outline"
			className="border-border h-11 shrink-0 rounded-[9px] border bg-transparent px-4 text-sm font-medium"
		>
			<Link prefetch href={`/workshops/${moduleSlug}/${slug}`}>
				{isInProgress ? 'Continue' : 'Start'}
			</Link>
		</Button>
	)
}

export const WorkshopSidebarMobile = ({
	workshop,
	className,
	pricingProps,
	interestCapture = false,
	purchased = false,
}: {
	workshop?: MinimalWorkshop | null
	className?: string
	pricingProps?: WorkshopPageProps
	interestCapture?: boolean
	purchased?: boolean
}) => {
	const { fields } = workshop ?? {}

	const handleScrollToBuy = (
		e: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
	) => {
		e.preventDefault()
		const buySection = document.getElementById('buy')
		buySection?.scrollIntoView({
			behavior: 'smooth',
			block: 'start',
		})
	}

	return (
		<div
			className={cn(
				'bg-background/90 backdrop-blur-xs fixed bottom-0 left-0 z-20 flex w-full items-center justify-between gap-3 border-t px-3 py-3 transition-opacity duration-300 md:hidden',
				className,
			)}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				<h3 className="font-heading truncate text-sm font-semibold">
					{fields?.title}
				</h3>
				<Contributor className="gap-1 text-sm [&_img]:w-5" />
			</div>
			{interestCapture ? (
				<Button
					className={cn(WORKSHOP_CTA_BUTTON, 'h-11 shrink-0 gap-2 text-sm')}
					onClick={handleScrollToBuy}
				>
					Get notified
				</Button>
			) : purchased && fields?.slug ? (
				<ContinueLearningButton moduleSlug={fields.slug} />
			) : (
				workshop &&
				pricingProps && (
					<InlineBuyButton
						className="**:data-divider:mx-1 **:data-label:text-sm h-11 shrink-0 gap-2 px-5"
						resource={workshop}
						pricingDataLoader={pricingProps.pricingDataLoader}
						pricingProps={pricingProps as any}
						centered={false}
						resourceType="workshop"
						pricingOptions={{
							withTitle: false,
							withImage: false,
						}}
					/>
				)
			)}
		</div>
	)
}
