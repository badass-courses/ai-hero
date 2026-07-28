'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { createAppAbility } from '@/ability'
import { api } from '@/trpc/react'
import {
	ArrowRightEndOnRectangleIcon,
	UserIcon,
} from '@heroicons/react/24/outline'
import { ChevronDownIcon } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'

import {
	DropdownMenu,
	DropdownMenuContent,
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
 * Skeleton placeholder to ensure consistent tree structure during hydration.
 * Using a separate component keeps the tree shape identical between server and client.
 */
const UserMenuSkeleton = () => (
	<li className="flex items-center">
		<Skeleton className="bg-foreground/10 h-2 w-10 rounded" />
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
							<span className="inline-flex items-center gap-0.5 text-[13px] leading-none text-[color:var(--ah-fg-muted)]">
								<span className="truncate sm:max-w-[8rem] lg:max-w-[11rem] xl:max-w-none">
									{sessionData.user.name?.split(' ')[0] || 'Account'}
								</span>
								<ChevronDownIcon className="w-2" />
							</span>
						</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						side="bottom"
						align="end"
						className="-translate-y-1 rounded-none shadow-lg"
					>
						<DropdownMenuLabel>
							{sessionData.user.email || 'Account'}
						</DropdownMenuLabel>
						<DropdownMenuSeparator className="bg-foreground/10" />
						<ul className="flex flex-col">
							{canViewInvoice && (
								<NavLinkItem variant="menu" href="/invoices" label="Invoices" />
							)}
							<NavLinkItem variant="menu" href="/profile" label="Profile" />

							{canCreateContent && (
								<NavLinkItem
									variant="menu"
									href="/admin/dashboard"
									label="Admin"
								/>
							)}
							{sessionStatus === 'authenticated' && (
								<NavLinkItem
									variant="menu"
									href="#"
									label="Feedback"
									onClick={() => setIsFeedbackDialogOpen(true)}
								/>
							)}
							<DropdownMenuSeparator className="bg-foreground/10" />
							<NavLinkItem
								variant="menu"
								href="#"
								label="Log out"
								onClick={() => signOut()}
								icon={<ArrowRightEndOnRectangleIcon className="mr-2 h-4 w-4" />}
							/>
						</ul>
					</DropdownMenuContent>
				</DropdownMenu>
			</li>
		</>
	)
}
