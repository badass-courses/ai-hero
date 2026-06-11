'use client'

import * as React from 'react'
import Image from 'next/image'
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

/**
 * Skeleton placeholder to ensure consistent tree structure during hydration.
 * Using a separate component keeps the tree shape identical between server and client.
 */
const UserMenuSkeleton = () => (
	<div className="flex items-stretch">
		<div className="flex h-full items-center justify-center px-5">
			<Skeleton className="bg-foreground/10 h-2 w-10 rounded" />
		</div>
	</div>
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
		return (
			<NavLinkItem
				icon={
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="mr-1 size-4"
						fill="none"
						viewBox="0 0 24 24"
					>
						<path
							stroke="currentColor"
							strokeWidth="1.5"
							d="M2.5 12c0-4.478 0-6.718 1.391-8.109S7.521 2.5 12 2.5c4.478 0 6.718 0 8.109 1.391S21.5 7.521 21.5 12c0 4.478 0 6.718-1.391 8.109C18.717 21.5 16.479 21.5 12 21.5c-4.478 0-6.718 0-8.109-1.391C2.5 18.717 2.5 16.479 2.5 12Z"
						/>
						<path
							stroke="currentColor"
							strokeLinecap="round"
							strokeWidth="1.5"
							d="M7.5 17c2.332-2.442 6.643-2.557 9 0m-2.005-7.5c0 1.38-1.12 2.5-2.503 2.5a2.502 2.502 0 0 1-2.504-2.5c0-1.38 1.12-2.5 2.504-2.5a2.502 2.502 0 0 1 2.503 2.5Z"
						/>
					</svg>
				}
				className="rounded-none"
				label="Log In"
				href="/login"
			/>
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
			<li className="hidden items-stretch sm:flex">
				<DropdownMenu modal={false}>
					<DropdownMenuTrigger className="group/nav-item flex items-center px-5">
						<span className="group-hover/nav-item:bg-muted group-data-[state=open]/nav-item:bg-muted inline-flex items-center gap-2 rounded-full pr-3 transition-colors duration-200">
							{userAvatar}
							<span className="text-foreground-muted inline-flex items-center gap-0.5 text-sm leading-tight">
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
