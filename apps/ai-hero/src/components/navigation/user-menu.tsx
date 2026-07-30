'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { createAppAbility } from '@/ability'
import { TYPE } from '@/components/landing/type'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ChevronDownIcon, LogOut } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Gravatar,
	Skeleton,
} from '@coursebuilder/ui'
import { useFeedback } from '@coursebuilder/ui/feedback-widget'
import { cn } from '@coursebuilder/utils/cn'

import { NavLinkItem } from './nav-link-item'
import { navTextLink } from './nav-pill'

/**
 * One row of the account menu.
 *
 * `TYPE.nav` is the size a navigation row wears (13.5px, no weight of its own),
 * which is what these are — the menu is an extension of the bar it hangs from,
 * not a dialog. It used to come through `NavLinkItem`'s `menu` variant at
 * `text-xl sm:text-sm`, a range that exists because that variant is shared with
 * the full-screen mobile sheet, where 20px is right and here it never was.
 *
 * The wash is `foreground/[0.06]`, matching the trigger above and every pill in
 * the bar, rather than the primitive's `bg-accent`. Same reason `NavPill` gives:
 * in dark mode the muted surfaces sit two points off the page, so a highlight
 * drawn from them disappears at exactly the moment it has a job to do.
 */
const accountMenuRow = cn(
	TYPE.nav,
	'text-[color:var(--ah-fg-muted)] focus:bg-foreground/[0.06] focus:text-foreground cursor-pointer rounded-sm px-2.5 py-2 transition-colors duration-200',
)

/**
 * A navigating row of the account menu.
 *
 * `DropdownMenuItem asChild` rather than a `Button` in a `<ul>`, which is what
 * this was. The panel is `role="menu"`, and a menu's children have to be
 * `menuitem`s for the arrow keys to reach them — the old markup put list items
 * inside it, so the menu opened focus-trapped with nothing to step through, and
 * every row drew its own hover out of the shared `Button` (which rule 12 notes
 * hardcodes `rounded-none`, hence the square highlights).
 *
 * Keeps `NavLinkItem`'s `nav_link_clicked` event so the change is invisible in
 * analytics.
 */
function AccountMenuLink({ href, label }: { href: string; label: string }) {
	return (
		<DropdownMenuItem asChild className={accountMenuRow}>
			<Link
				href={href}
				prefetch
				onClick={() => track('nav_link_clicked', { label, href })}
			>
				{label}
			</Link>
		</DropdownMenuItem>
	)
}

/**
 * Skeleton placeholder to ensure consistent tree structure during hydration.
 * Using a separate component keeps the tree shape identical between server and client.
 */
/**
 * `w-[35px]` is measured, not guessed: it is the resolved width of the "Log in"
 * link this skeleton stands in for. At `w-10` (40px) the bar reflowed 5px the
 * moment the session landed.
 */
const UserMenuSkeleton = () => (
	<li className="flex items-center">
		<Skeleton className="bg-foreground/10 h-2 w-[35px] rounded" />
	</li>
)

/**
 * Desktop user menu component with dropdown.
 * Uses mounted state to prevent hydration mismatch from session status changes.
 */
export const UserMenu = () => {
	const [mounted, setMounted] = React.useState(false)
	const { data: sessionData, status: sessionStatus } = useSession()
	const { data: abilityRules } = api.ability.getCurrentAbilityRules.useQuery()
	const ability = createAppAbility(abilityRules || [])

	const canViewTeam = ability.can('invite', 'Team')
	const canCreateContent = ability.can('create', 'Content')
	const canViewInvoice = ability.can('read', 'Invoice')
	const isAdmin = ability.can('manage', 'all')
	const { setIsFeedbackDialogOpen } = useFeedback()

	React.useEffect(() => {
		setMounted(true)
	}, [])

	// Always render skeleton on server and initial client render to match tree structure
	if (!mounted || sessionStatus === 'loading') {
		return <UserMenuSkeleton />
	}

	if (!sessionData?.user?.email) {
		// A word, not a glyph: the desktop cluster reads `Search · Newsletter ·
		// Log in`, and an outlined person icon in that row was the only item a
		// reader had to decode.
		return (
			<li className="flex items-center">
				<Link href="/login" className={navTextLink}>
					Log in
				</Link>
			</li>
		)
	}

	const userAvatar = sessionData.user.image ? (
		<Image
			src={sessionData.user.image}
			alt={sessionData.user.name || ''}
			width={28}
			height={28}
			className="rounded-full"
		/>
	) : (
		<Gravatar
			className="h-7 w-7 rounded-full"
			email={sessionData.user.email}
			default="mp"
		/>
	)

	return (
		<>
			{canViewTeam && !isAdmin && (
				<NavLinkItem label="Invite Team" className="" href="/team" />
			)}
			<li className="flex items-center">
				<DropdownMenu modal={false}>
					<DropdownMenuTrigger className="group/nav-item focus-visible:ring-ring flex items-center rounded-[7px] focus-visible:outline-none focus-visible:ring-2">
						<span className="group-hover/nav-item:bg-foreground/[0.06] group-data-[state=open]/nav-item:bg-foreground/[0.06] inline-flex items-center gap-2 rounded-[7px] p-1 pr-2.5 transition-colors duration-200">
							{userAvatar}
							{/* 13px, the size of `Search · Newsletter` beside it (`navTextLink`),
							    so the account control reads as one more item in that cluster
							    rather than as its own thing. */}
							<span
								className={cn(
									TYPE.metaSm,
									'inline-flex items-center gap-1 text-[color:var(--ah-fg-muted)] group-hover/nav-item:text-foreground group-data-[state=open]/nav-item:text-foreground transition-colors duration-200',
								)}
							>
								<span className="truncate sm:max-w-[8rem] lg:max-w-[11rem] xl:max-w-none">
									{sessionData.user.name?.split(' ')[0] || 'Account'}
								</span>
								{/* Was `w-2` — 8px, which rendered as a smudge rather than a
								    glyph. 12px matches the icon size the menu rows use, and it
								    turns over when the menu opens so the control says which
								    way it is pointing. */}
								<ChevronDownIcon
									aria-hidden
									className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/nav-item:rotate-180"
								/>
							</span>
						</span>
					</DropdownMenuTrigger>
					{/* No radius override. The panel takes the shared popover radius
					    (`rounded-md`, 11px — rule 12's "card") like every other menu on
					    the site; it used to set `rounded-none`, which read as a torn-off
					    corner of the page rather than an object resting on it. The
					    `-translate-y-1` went with it: it was fighting the primitive's own
					    `sideOffset`, so the gap under the bar is set there instead. */}
					<DropdownMenuContent
						side="bottom"
						align="end"
						sideOffset={8}
						className="w-56 p-1.5 shadow-lg"
					>
						{/* The account you are in — identification, not an action. Set one
						    step down from the rows and in the subtle ink so the things you
						    can actually press are what the eye lands on. It was `text-sm
						    font-semibold`, which made the email the loudest thing here. */}
						<DropdownMenuLabel
							className={cn(
								TYPE.metaSm,
								'truncate px-2.5 py-1.5 font-normal text-[color:var(--ah-fg-subtle)]',
							)}
						>
							{sessionData.user.email || 'Account'}
						</DropdownMenuLabel>
						<DropdownMenuSeparator className="-mx-1.5 my-1.5 bg-[color:var(--ah-line-soft)]" />
						{canViewInvoice && (
							<AccountMenuLink href="/invoices" label="Invoices" />
						)}
						<AccountMenuLink href="/profile" label="Profile" />
						{canCreateContent && (
							<AccountMenuLink href="/admin/dashboard" label="Admin" />
						)}
						{sessionStatus === 'authenticated' && (
							<DropdownMenuItem
								className={accountMenuRow}
								onSelect={() => setIsFeedbackDialogOpen(true)}
							>
								Feedback
							</DropdownMenuItem>
						)}
						<DropdownMenuSeparator className="-mx-1.5 my-1.5 bg-[color:var(--ah-line-soft)]" />
						<DropdownMenuItem
							className={accountMenuRow}
							onSelect={() => signOut()}
						>
							<LogOut aria-hidden className="size-3.5 shrink-0" />
							Log out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</li>
		</>
	)
}
