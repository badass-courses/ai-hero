'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@coursebuilder/utils/cn'
import { useSession } from 'next-auth/react'

import { NavPill } from './nav-pill'

export function Login({ className }: { className?: string }) {
	const pathname = usePathname()
	const { data: sessionData, status: sessionStatus } = useSession()
	const isLoadingUserInfo = sessionStatus === 'loading'
	const isActive = pathname === '/login'

	return (
		<>
			{isLoadingUserInfo || sessionData?.user?.email ? null : (
				<Link
					href="/login"
					className={cn(
						'group/nav-item flex items-center font-semibold transition',
						className,
					)}
				>
					<NavPill active={isActive || undefined}>Log in</NavPill>
				</Link>
			)}
		</>
	)
}
