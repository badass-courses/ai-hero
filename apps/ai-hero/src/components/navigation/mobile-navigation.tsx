'use client'

import * as React from 'react'
import Link from 'next/link'
import { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { Menu, Search, X } from 'lucide-react'

type MobileNavigationProps = {
	isMobileMenuOpen: boolean
	setIsMobileMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
	onSearchOpen: () => void
	subscriber?: Subscriber | null
	/**
	 * Whether this route mounts the search palette at all. The desktop bar
	 * already hides its Search link on `minimal` routes; without this the mobile
	 * glyph stayed and opened nothing, because the palette it toggles is not
	 * rendered there.
	 */
	showSearch?: boolean
}

/**
 * Mobile top-bar controls (right side, < lg): search (opens the full-screen
 * search palette), an optional newsletter link, and the hamburger that toggles
 * the navigation drawer. The drawer itself (`MobileMenuPanel`) is a fixed
 * full-height sheet from the left, so it overlays the page rather than pushing
 * it down — the hub tree is far too tall to push.
 */
export const MobileNavigation: React.FC<MobileNavigationProps> = ({
	isMobileMenuOpen,
	setIsMobileMenuOpen,
	onSearchOpen,
	subscriber,
	showSearch = true,
}) => {
	// Glyphs, not words, below `lg`: the bar is 18px-gutter wide on a phone and
	// three labelled links would not fit beside the wordmark. The desktop bar
	// spells them out (see `Navigation`); this is the one place icons win.
	// Opaque stroke dimmed by element opacity, NOT a translucent one. These are
	// multi-path glyphs — the search circle meets its handle, the envelope's flap
	// crosses its body — and with the alpha in the stroke each overlap composites
	// twice, so the joins read darker than the rest of the icon. Fading the whole
	// shape once keeps it even. Values match `--ah-fg-muted` in both schemes.
	// (Same fix as the related-reading arrow.)
	const control =
		'text-foreground opacity-70 hover:bg-foreground/[0.06] hover:opacity-100 focus-visible:ring-ring flex size-9 items-center justify-center rounded-[7px] transition focus-visible:outline-none focus-visible:ring-2 dark:opacity-60 dark:hover:opacity-100'

	return (
		<div className="ml-auto flex items-center gap-0.5 lg:hidden">
			{showSearch && (
				<button
					type="button"
					aria-label="Search"
					onClick={() => {
						track('search_palette_opened', { via: 'mobile_nav_icon' })
						onSearchOpen()
					}}
					className={control}
				>
					<Search aria-hidden className="size-5" />
				</button>
			)}
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
					className={control}
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
			<button
				className={control}
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
			</button>
		</div>
	)
}
