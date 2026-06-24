'use client'

import * as React from 'react'
import Link from 'next/link'
import { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { Menu, Search, X } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

import { SEARCH_HREF } from './primary-nav'

type MobileNavigationProps = {
	isMobileMenuOpen: boolean
	setIsMobileMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
	subscriber?: Subscriber | null
}

/**
 * Mobile top-bar controls (right side, < lg): search → /posts, an optional
 * newsletter link, and the hamburger that toggles the push-down menu panel.
 * The panel itself is rendered as a sibling of the header (see
 * `MobileMenuPanel`) so it pushes content down instead of overlaying it.
 */
export const MobileNavigation: React.FC<MobileNavigationProps> = ({
	isMobileMenuOpen,
	setIsMobileMenuOpen,
	subscriber,
}) => {
	return (
		<div className="flex items-stretch lg:hidden">
			<Link
				href={SEARCH_HREF}
				aria-label="Browse all posts"
				onClick={() =>
					track('nav_link_clicked', { label: 'Search', href: SEARCH_HREF })
				}
				className="hover:bg-muted focus-visible:ring-ring flex aspect-square items-center justify-center border-l transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
			>
				<Search aria-hidden className="size-5" />
			</Link>
			{!subscriber && (
				<Link
					href="/newsletter"
					aria-label="Subscribe to the newsletter"
					onClick={() =>
						track('nav_link_clicked', {
							label: 'Newsletter',
							href: '/newsletter',
						})
					}
					className="hover:bg-muted focus-visible:ring-ring flex aspect-square items-center justify-center border-l transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="size-5"
						fill="none"
						viewBox="0 0 24 24"
					>
						<path
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="1.5"
							d="M6 8h8m-8 4h8m-8 4h4m8-8h1c1.414 0 2.121 0 2.56.44.44.439.44 1.146.44 2.56v8a2 2 0 1 1-4 0V8Z"
						/>
						<path
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="1.5"
							d="M12 3H8c-2.828 0-4.243 0-5.121.879C2 4.757 2 6.172 2 9v6c0 2.828 0 4.243.879 5.121C3.757 21 5.172 21 8 21h12a2 2 0 0 1-2-2V9c0-2.828 0-4.243-.879-5.121C16.243 3 14.828 3 12 3Z"
						/>
					</svg>
				</Link>
			)}
			<Button
				variant="ghost"
				className="h-(--nav-height) aspect-square items-center justify-center rounded-none border-l"
				type="button"
				aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
				aria-expanded={isMobileMenuOpen}
				aria-controls="mobile-menu-panel"
				onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
			>
				{isMobileMenuOpen ? (
					<X className="size-5" />
				) : (
					<Menu className="size-5" />
				)}
			</Button>
		</div>
	)
}
