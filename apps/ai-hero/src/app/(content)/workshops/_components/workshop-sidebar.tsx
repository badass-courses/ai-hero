'use client'

import React, { useRef } from 'react'
import Link from 'next/link'
import { Contributor } from '@/components/contributor'
import config from '@/config'
import { env } from '@/env.mjs'
import type { MinimalWorkshop } from '@/lib/workshops'
import { useInView } from 'framer-motion'
import { useMeasure } from 'react-use'

import { Button, ScrollArea } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	InlineBuyButton,
	type PricingComponentProps,
} from './inline-mdx-pricing'
import { WORKSHOP_CTA_BUTTON } from './workshop-notify-button'
import type { WorkshopPageProps } from './workshop-page-props'

export const WorkshopSidebar = ({
	children,
	sticky = true,
	workshop,
	className,
	pricingProps,
	interestCapture = false,
}: {
	children: React.ReactNode
	sticky?: boolean
	workshop?: MinimalWorkshop | null
	className?: string
	pricingProps?: WorkshopPageProps
	interestCapture?: boolean
}) => {
	// The buy/waitlist widget, as opposed to the interest-capture CTA or the
	// resource list. Only this one needs the shell to inset it.
	const isPricingState = Boolean(pricingProps) && !interestCapture
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
				className={cn('scroll-mt-15 relative flex h-full flex-col', className)}
			>
				{/* Only the pricing widget needs the shell to pad it — its content
				    starts flush at the top edge. The interest-capture CTA and the
				    resource list both bring their own padding (the list is deliberately
				    full-bleed), so padding the shell for everyone double-inset them.
				    On `#buy` rather than here it would be worse still: that one is
				    `h-full` and spans the whole article, so the padding would land in
				    dead space and shift the sticky offset. */}
				<div
					ref={sidebarRef}
					className={cn(
						{ 'px-6 py-8': isPricingState },
						{
							'md:top-(--nav-height) md:sticky': true, //sticky && windowHeight - 63 > height,
						},
					)}
				>
					<ScrollArea
						className={cn(
							"h-full [&_[data-slot='scroll-area-scrollbar']]:opacity-50",
							// Subtract exactly what the wrapper added, so a long Includes
							// list still ends inside the viewport rather than under it.
							isPricingState
								? 'lg:max-h-[calc(100vh-var(--nav-height)-4rem)]'
								: 'lg:max-h-[calc(100vh-var(--nav-height))]',
						)}
					>
						{children}
						{!interestCapture && !Boolean(windowHeight - 63 > height) && (
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
			/>
		</>
	)
}

export const WorkshopSidebarMobile = ({
	workshop,
	className,
	pricingProps,
	interestCapture = false,
}: {
	workshop?: MinimalWorkshop | null
	className?: string
	pricingProps?: WorkshopPageProps
	interestCapture?: boolean
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
			<div className="flex flex-col gap-0.5">
				<h3 className="font-heading text-sm font-semibold">{fields?.title}</h3>
				<Contributor className="gap-1 text-sm [&_img]:w-5" />
				{/* <p className="text-sm opacity-75">{config.author}</p> */}
			</div>
			{interestCapture ? (
				<Button
					className={cn(WORKSHOP_CTA_BUTTON, 'h-10 gap-2 text-sm')}
					onClick={handleScrollToBuy}
				>
					Get notified
				</Button>
			) : (
				workshop &&
				pricingProps && (
					<InlineBuyButton
						className="**:data-divider:mx-1 **:data-label:text-sm h-10 gap-2 px-5"
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
