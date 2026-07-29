import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { track } from '@/utils/analytics'
import { ChevronRight } from 'lucide-react'
import { z } from 'zod'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import { NavPill } from './nav-pill'

const NavLinkItemSchema = z.object({
	href: z.string().optional(),
	label: z.union([z.string(), z.any()]),
	onClick: z.function().optional(),
	className: z.string().optional(),
	icon: z.any().optional(),
	variant: z.enum(['nav', 'menu']).default('nav').optional(),
	textLabel: z.string().optional(),
})

export type NavLinkItem = z.infer<typeof NavLinkItemSchema>

/**
 * NavLinkItem component that can be used in both navigation and menu contexts
 * @param variant 'nav' for main navigation, 'menu' for dropdown/sheet menus
 */
export const NavLinkItem: React.FC<NavLinkItem> = ({
	href,
	label,
	onClick,
	className,
	icon,
	textLabel,
	variant = 'nav',
}) => {
	const pathname = usePathname()
	const isActive = href && pathname === href.replace(/\/$/, '')

	const handleClick = () => {
		track('nav_link_clicked', {
			label: typeof label === 'string' ? label : textLabel,
			href,
		})
		onClick && onClick()
	}

	const innerContent = (
		<>
			{icon && icon}
			<span className="wrap-break-word whitespace-normal text-balance">
				{label}
			</span>
		</>
	)

	const content =
		variant === 'nav' ? (
			<NavPill active={isActive || undefined}>{innerContent}</NavPill>
		) : (
			innerContent
		)

	// `nav` is the primary-bar link: the pill inside carries the geometry, so the
	// anchor itself is a bare inline box (the bar is `items-center`, not
	// full-height stretch, per the redesign spec).
	const styles = {
		nav: 'group/nav-item text-[color:var(--ah-fg-muted)] hover:text-foreground relative flex h-auto w-auto items-center justify-start p-0 text-[13.5px] font-normal transition hover:no-underline',
		menu: 'text-foreground hover:bg-background flex w-full items-center justify-start font-normal text-xl hover:no-underline px-3 sm:text-sm',
	}

	return (
		<li className={variant === 'nav' ? 'flex items-center' : 'flex items-stretch'}>
			<Button
				className={cn(
					styles[variant],
					{
						'': isActive,
						'bg-muted': isActive && variant === 'menu',
					},
					className,
				)}
				asChild={!onClick}
				variant="link"
				onClick={onClick}
			>
				{onClick ? (
					content
				) : (
					<Link
						prefetch
						href={href!}
						onClick={handleClick}
						// The pill and the mobile underline are the only "you are
						// here" signals otherwise, and both are colour alone.
						// `PrimaryEntryLink` in `index.tsx` already announces itself
						// this way; the rest of the bar should too.
						aria-current={isActive ? 'page' : undefined}
						className={cn('relative', {
							'underline md:no-underline': isActive,
						})}
					>
						{/* {isActive && (
							<ChevronRight className="text-primary absolute left-0 top-1/2 -translate-y-1/2 md:hidden" />
						)} */}
						{content}
					</Link>
				)}
			</Button>
		</li>
	)
}
