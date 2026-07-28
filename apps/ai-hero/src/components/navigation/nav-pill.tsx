import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * Inner highlight for nav items.
 * The parent (trigger/link) owns the full hover/click target and must carry
 * the `group` class. NavPill renders the visible highlight that activates on
 * hover, open, or active state.
 *
 * Geometry is the redesign spec's primary-nav link: 13.5px, `7px 12px`,
 * `border-radius:7px`, active `rgba(255,255,255,.1)` over the ink. The wash
 * is `foreground/10` rather than `bg-muted` on purpose — in dark mode `--muted`
 * (#0d0d0c) is two points off the page and the active item simply disappears.
 */
export function NavPill({
	children,
	active,
	className,
}: {
	children: React.ReactNode
	active?: boolean
	className?: string
}) {
	return (
		<span
			data-active={active ? '' : undefined}
			className={cn(
				'inline-flex items-center rounded-[7px] px-3 py-[7px] text-[13.5px] leading-none transition-colors duration-200',
				'group-hover/nav-item:bg-foreground/[0.06] group-hover/nav-item:text-foreground',
				'group-data-[state=open]/nav-item:bg-foreground/[0.06] group-data-[state=open]/nav-item:text-foreground',
				'data-active:bg-foreground/10 data-active:text-foreground',
				className,
			)}
		>
			{children}
		</span>
	)
}

/**
 * The right-hand cluster of the primary bar is words, not glyphs: `Search ·
 * Newsletter · Log in` at 13px, muted, an 18px gap between them, and then the
 * one gold action. Plain text is what the redesign asks for and it is also what
 * a stranger can read — a magnifier and an envelope side by side are two
 * puzzles in a row.
 *
 * Lives here rather than in `navigation/index.tsx` so `UserMenu` can dress its
 * "Log in" identically without importing its own parent.
 */
export const navTextLink =
	'text-[color:var(--ah-fg-muted)] hover:text-foreground focus-visible:ring-ring inline-flex items-center rounded-[6px] text-[13px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2'

/**
 * Class string that resets NavigationMenuTrigger's default open/hover background
 * and text overrides so the visible highlight comes from the inner NavPill only.
 * Pair with `<NavPill>` wrapping the trigger's icon + label.
 */
export const navTriggerReset =
	'px-2 bg-transparent hover:bg-transparent focus:bg-transparent focus:text-foreground data-[state=open]:bg-transparent data-[state=open]:hover:bg-transparent data-[state=open]:focus:bg-transparent data-[state=open]:text-foreground'

/**
 * Class string that resets NavigationMenuLink's default hover/focus/active background
 * overrides so the visible highlight comes from the inner NavPill only.
 * Pair with `<NavPill>` wrapping the link's icon + label.
 */
export const navLinkReset =
	'bg-transparent hover:bg-transparent focus:bg-transparent focus:text-foreground data-[active=true]:bg-transparent data-[active=true]:hover:bg-transparent data-[active=true]:focus:bg-transparent data-[active=true]:text-foreground'
