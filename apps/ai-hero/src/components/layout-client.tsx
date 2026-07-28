'use client'

import { useParams } from 'next/navigation'

import { cn } from '@coursebuilder/ui/utils/cn'

import Navigation from './navigation'
import Footer from './navigation/footer'

/**
 * Client-side layout component that handles container styling and side patterns
 *
 * `withFooter={false}` is how a page opts out of the shell's own footer. Hub
 * pages do exactly that and let `HubLayout` render the footer inside the
 * sidebar grid's content column instead, so the sidebar's border runs the full
 * height of the page rather than stopping above the footer.
 */
export default function LayoutClient({
	children,
	withContainer = false,
	className,
	withNavigation = true,
	withFooter = true,
}: {
	children: React.ReactNode
	withContainer?: boolean
	className?: string
	withNavigation?: boolean
	withFooter?: boolean
}) {
	return (
		// No nav rendered -> zero --nav-height for this subtree so descendant
		// 100dvh-var(--nav-height) calcs (editor shells) stay flush.
		<div
			className={cn(
				'',
				!withNavigation && '[--nav-height:0px]',
				{
					// The redesign's shell is 1440px wide — that is the *bordered*
					// box, so the wrapper caps at 1440 + 2×8px of page-background
					// gutter and the `border-x` below lands exactly on 1440.
					'relative mx-auto w-full max-w-[1456px] px-2': withContainer,
				},
				className,
			)}
		>
			{/* {withContainer && (
				<div className="bg-stripes absolute bottom-0 left-0 top-0 flex h-full min-h-screen w-2 flex-col sm:w-2" />
			)} */}
			<div className="bg-background border-x print:border-none">
				{withNavigation && <Navigation />}
				{children}
				{withFooter && <Footer />}
			</div>
			{/* {withContainer && (
				<div className="bg-stripes absolute bottom-0 right-0 top-0 flex h-full min-h-screen w-2 flex-col sm:w-2" />
			)} */}
		</div>
	)
}
