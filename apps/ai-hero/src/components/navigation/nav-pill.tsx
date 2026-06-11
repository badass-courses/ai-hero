import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * Inner highlight for nav items.
 * The parent (trigger/link) owns the full hover/click target and must carry
 * the `group` class. NavPill renders the visible highlight that activates on
 * hover, open, or active state.
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
				'inline-flex items-center rounded-full px-3 py-1.5 transition-colors duration-200',
				'group-hover/nav-item:bg-muted group-data-[state=open]/nav-item:bg-muted group-data-[active=true]/nav-item:bg-muted data-active:bg-muted',
				className,
			)}
		>
			{children}
		</span>
	)
}

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
